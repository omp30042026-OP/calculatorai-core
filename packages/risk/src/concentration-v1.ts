import type { ParsedDecision } from "../../cds/src/validate.js";
import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";
import type {
  ConcentrationRiskReport,
  ItemVendorExposure,
  VendorExposure,
} from "./concentration.js";

export type ConcentrationDeltaItem = {
  item_id: string;
  baseline_top_vendor_share: number | null;
  simulated_top_vendor_share: number | null;
  delta_top_vendor_share: number | null;
  baseline_top_vendor_entity_id: string | null;
  simulated_top_vendor_entity_id: string | null;
};

export type ConcentrationDeltaVendor = {
  entity_id: string;
  baseline_share: number;
  simulated_share: number;
  delta_share: number;
  baseline_spend: number;
  simulated_spend: number;
  delta_spend: number;
};

export type ConcentrationDeltaReport = {
  items: ConcentrationDeltaItem[];
  vendors: ConcentrationDeltaVendor[];
  notes: string[];
};

export function computeConcentrationRiskBaselineV1(
  d: ParsedDecision
): ConcentrationRiskReport {
  const volumeByItem = latestVolumeByItemFromObservations(d);
  const costByItemVendor = latestCostByItemVendor(d);
  return buildReport(d, volumeByItem, costByItemVendor, /*costChanges*/ undefined, "BASELINE");
}

export function computeConcentrationRiskSimulatedV1(
  d: ParsedDecision,
  snaps: DecisionSnapshots
): ConcentrationRiskReport {
  const volumeByItem = volumeByItemFromSnapshots(snaps);
  const costByItemVendor = latestCostByItemVendor(d);

  // per item, cost change ids applied (from snapshot simulation boundary)
  const costChangeIdsByItem = new Map<string, string[]>();
  for (const row of snaps.simulated) {
    const ids = row.metrics.unit_cost.applied_change_ids ?? [];
    costChangeIdsByItem.set(row.item_id, [...ids]);
  }

  return buildReport(d, volumeByItem, costByItemVendor, costChangeIdsByItem, "SIMULATED");
}

export function computeConcentrationDeltaV1(
  baseline: ConcentrationRiskReport,
  simulated: ConcentrationRiskReport
): ConcentrationDeltaReport {
  const bItem = new Map(baseline.item_exposure.map((x) => [x.item_id, x]));
  const sItem = new Map(simulated.item_exposure.map((x) => [x.item_id, x]));

  const itemIds = new Set<string>([
    ...bItem.keys(),
    ...sItem.keys(),
  ]);

  const items: ConcentrationDeltaItem[] = [...itemIds]
    .sort((a, b) => a.localeCompare(b))
    .map((item_id) => {
      const bi = bItem.get(item_id);
      const si = sItem.get(item_id);

      const bTop = bi?.top_vendor ?? null;
      const sTop = si?.top_vendor ?? null;

      const bShare = bTop ? bTop.spend_share_of_item : null;
      const sShare = sTop ? sTop.spend_share_of_item : null;

      const delta =
        bShare == null || sShare == null ? null : sShare - bShare;

      return {
        item_id,
        baseline_top_vendor_share: bShare,
        simulated_top_vendor_share: sShare,
        delta_top_vendor_share: delta,
        baseline_top_vendor_entity_id: bTop ? bTop.entity_id : null,
        simulated_top_vendor_entity_id: sTop ? sTop.entity_id : null,
      };
    });

  const bVendor = new Map(baseline.vendor_exposure.map((v) => [v.entity_id, v]));
  const sVendor = new Map(simulated.vendor_exposure.map((v) => [v.entity_id, v]));
  const vendorIds = new Set<string>([...bVendor.keys(), ...sVendor.keys()]);

  const vendors: ConcentrationDeltaVendor[] = [...vendorIds]
    .sort((a, b) => a.localeCompare(b))
    .map((entity_id) => {
      const b = bVendor.get(entity_id);
      const s = sVendor.get(entity_id);

      const bShare = b?.spend_share ?? 0;
      const sShare = s?.spend_share ?? 0;
      const bSpend = b?.total_spend ?? 0;
      const sSpend = s?.total_spend ?? 0;

      return {
        entity_id,
        baseline_share: bShare,
        simulated_share: sShare,
        delta_share: sShare - bShare,
        baseline_spend: bSpend,
        simulated_spend: sSpend,
        delta_spend: sSpend - bSpend,
      };
    })
    .sort((a, b) => Math.abs(b.delta_share) - Math.abs(a.delta_share));

  return {
    items,
    vendors,
    notes: [
      "v1 delta compares baseline vs simulated concentration (shares + spend).",
      "If vendor-level volume is unavailable, both baseline and simulated use equal vendor volume split per item.",
    ],
  };
}

/* ------------------------------ internals ------------------------------ */

type VolRec = { value: number; obs_id: string };
type CostRec = { value: number; obs_id: string };

function buildReport(
  d: ParsedDecision,
  volumeByItem: Map<string, VolRec>,
  baseCostByItemVendor: Map<string, Map<string, CostRec>>,
  costChangeIdsByItem: Map<string, string[]> | undefined,
  scenario: "BASELINE" | "SIMULATED"
): ConcentrationRiskReport {
  const entityName = new Map(d.baseline.entities.map((e) => [e.entity_id, e.name]));
  const itemName = new Map(d.baseline.items.map((i) => [i.item_id, i.name]));

  // stable order of change ids = decision change_set order
  const changeOrder = new Map<string, number>();
  d.change_set.forEach((c, idx) => changeOrder.set(c.change_id, idx));
  const changeById = new Map(d.change_set.map((c) => [c.change_id, c]));

  const item_exposure: ItemVendorExposure[] = [];
  const vendorSpend = new Map<string, number>();

  for (const [item_id, vendors] of baseCostByItemVendor.entries()) {
    const volRec = volumeByItem.get(item_id);
    if (!volRec) continue;

    const volume = volRec.value;
    const vendorEntries = [...vendors.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (vendorEntries.length === 0) continue;

    const k = vendorEntries.length;
    const assumedVolumePerVendor = volume / k;

    const appliedCostChangeIds =
      scenario === "SIMULATED"
        ? (costChangeIdsByItem?.get(item_id) ?? [])
        : [];

    // apply item-level cost changes (COST_CHANGE targeting ITEM) to each vendor cost
    const orderedCostChanges = [...appliedCostChangeIds]
      .sort((a, b) => (changeOrder.get(a) ?? 1e9) - (changeOrder.get(b) ?? 1e9))
      .filter((id) => {
        const cs = changeById.get(id);
        return cs && cs.type === "COST_CHANGE" && cs.target.scope === "ITEM" && cs.target.item_id === item_id;
      });

    const vendorRows = vendorEntries.map(([entity_id, c]) => {
      let unit_cost = c.value;
      for (const cid of orderedCostChanges) {
        const cs = changeById.get(cid);
        if (!cs) continue;
        unit_cost = applyDelta(unit_cost, cs.delta);
      }

      const spend = unit_cost * assumedVolumePerVendor;
      vendorSpend.set(entity_id, (vendorSpend.get(entity_id) ?? 0) + spend);

      return {
        entity_id,
        entity_name: entityName.get(entity_id),
        unit_cost,
        assumed_volume: assumedVolumePerVendor,
        spend,
        cost_obs_id: c.obs_id,
        volume_obs_id: volRec.obs_id,
      };
    });

    const itemTotal = vendorRows.reduce((s, r) => s + r.spend, 0);
    const top = itemTotal > 0 ? [...vendorRows].sort((a, b) => b.spend - a.spend)[0] : null;

    const notes: string[] = [];
    if (k > 1) {
      notes.push(
        `ASSUMPTION: VOLUME has no vendor split; assumed equal split across ${k} vendors for item ${item_id}.`
      );
    }
    if (scenario === "SIMULATED" && orderedCostChanges.length) {
      notes.push(`SIM(v1): applied COST_CHANGE ids in order: ${orderedCostChanges.join(",")}`);
    }

    item_exposure.push({
      item_id,
      item_name: itemName.get(item_id),
      volume,
      vendors: vendorRows,
      top_vendor: top
        ? {
            entity_id: top.entity_id,
            entity_name: top.entity_name,
            spend_share_of_item: itemTotal > 0 ? top.spend / itemTotal : 0,
          }
        : null,
      notes,
    });
  }

  const total_spend = [...vendorSpend.values()].reduce((a, b) => a + b, 0);

  const vendor_exposure: VendorExposure[] = [...vendorSpend.entries()]
    .map(([entity_id, spend]) => {
      const share = total_spend > 0 ? spend / total_spend : 0;
      const flag = (share > 0.5 ? "WARN" : share > 0.25 ? "NOTE" : "OK") as VendorExposure["flag"];
      return {
        entity_id,
        entity_name: entityName.get(entity_id),
        total_spend: spend,
        spend_share: share,
        flag,
      };
    })
    .sort((a, b) => b.total_spend - a.total_spend);

  return {
    total_spend,
    vendor_exposure,
    item_exposure: item_exposure.sort((a, b) => a.item_id.localeCompare(b.item_id)),
    notes: [
      `v1 report scenario=${scenario}`,
      "Spend exposure uses UNIT_COST * VOLUME with equal vendor volume split when vendor volume is missing.",
      scenario === "SIMULATED"
        ? "Simulated uses snapshot volume and applies ITEM-level COST_CHANGE deltas to vendor costs."
        : "Baseline uses latest baseline observations only.",
    ],
  };
}

function applyDelta(cur: number, delta: any): number {
  if (delta?.kind === "RELATIVE") return cur * delta.multiplier;
  if (delta?.kind === "ABSOLUTE") return delta.new_value;
  if (delta?.kind === "ADD") return cur + delta.amount;
  return cur; // unsupported kinds: no-op
}

function latestVolumeByItemFromObservations(d: ParsedDecision): Map<string, VolRec> {
  const m = new Map<string, { t: number; value: number; obs_id: string }>();

  for (const o of d.baseline.observations) {
    if (o.metric !== "VOLUME") continue;
    const item_id = o.dims.item_id;
    if (!item_id) continue;

    const t = Date.parse(o.time);
    if (Number.isNaN(t)) continue;

    const prev = m.get(item_id);
    if (!prev || t >= prev.t) m.set(item_id, { t, value: o.value, obs_id: o.obs_id });
  }

  const out = new Map<string, VolRec>();
  for (const [k, v] of m.entries()) out.set(k, { value: v.value, obs_id: v.obs_id });
  return out;
}

function volumeByItemFromSnapshots(snaps: DecisionSnapshots): Map<string, VolRec> {
  const out = new Map<string, VolRec>();
  for (const row of snaps.simulated) {
    const v = row.metrics.volume.value;
    const obs = row.metrics.volume.from_observation_id ?? "SNAPSHOT";
    if (v == null) continue;
    out.set(row.item_id, { value: v, obs_id: obs });
  }
  return out;
}

function latestCostByItemVendor(
  d: ParsedDecision
): Map<string, Map<string, CostRec>> {
  const m = new Map<string, Map<string, { t: number; value: number; obs_id: string }>>();

  for (const o of d.baseline.observations) {
    if (o.metric !== "UNIT_COST") continue;

    const item_id = o.dims.item_id;
    const entity_id = o.dims.entity_id;
    if (!item_id || !entity_id) continue;

    const t = Date.parse(o.time);
    if (Number.isNaN(t)) continue;

    const byVendor = m.get(item_id) ?? new Map();
    const prev = byVendor.get(entity_id);
    if (!prev || t >= prev.t) byVendor.set(entity_id, { t, value: o.value, obs_id: o.obs_id });
    m.set(item_id, byVendor);
  }

  const out = new Map<string, Map<string, CostRec>>();
  for (const [item, byVendor] of m.entries()) {
    const clean = new Map<string, CostRec>();
    for (const [vendor, rec] of byVendor.entries()) clean.set(vendor, { value: rec.value, obs_id: rec.obs_id });
    out.set(item, clean);
  }
  return out;
}
