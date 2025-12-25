import type { ParsedDecision } from "../../cds/src/validate.js";

export type VendorExposure = {
  entity_id: string;
  entity_name?: string;
  total_spend: number;
  spend_share: number; // 0..1
  flag: "OK" | "NOTE" | "WARN";
};

export type ItemVendorExposure = {
  item_id: string;
  item_name?: string;

  volume: number;
  vendors: Array<{
    entity_id: string;
    entity_name?: string;
    unit_cost: number;
    assumed_volume: number;
    spend: number;
    cost_obs_id: string;
    volume_obs_id: string;
  }>;

  top_vendor: {
    entity_id: string;
    entity_name?: string;
    spend_share_of_item: number; // 0..1
  } | null;

  notes: string[];
};

export type ConcentrationRiskReport = {
  total_spend: number;
  vendor_exposure: VendorExposure[];
  item_exposure: ItemVendorExposure[];
  notes: string[];
};

export function computeConcentrationRiskV0(d: ParsedDecision): ConcentrationRiskReport {
  const entityName = new Map(d.baseline.entities.map((e) => [e.entity_id, e.name]));
  const itemName = new Map(d.baseline.items.map((i) => [i.item_id, i.name]));

  const volumeByItem = latestVolumeByItem(d); // item -> {value, obs_id}
  const costByItemVendor = latestCostByItemVendor(d); // item -> vendor -> {value, obs_id}

  const item_exposure: ItemVendorExposure[] = [];
  const vendorSpend = new Map<string, number>();

  for (const [item_id, vendors] of costByItemVendor.entries()) {
    const volRec = volumeByItem.get(item_id);
    if (!volRec) continue;

    const volume = volRec.value;
    const vendorEntries = [...vendors.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (vendorEntries.length === 0) continue;

    const k = vendorEntries.length;
    const assumedVolumePerVendor = volume / k;

    const vendorRows = vendorEntries.map(([entity_id, c]) => {
      const spend = c.value * assumedVolumePerVendor;
      vendorSpend.set(entity_id, (vendorSpend.get(entity_id) ?? 0) + spend);

      return {
        entity_id,
        entity_name: entityName.get(entity_id),
        unit_cost: c.value,
        assumed_volume: assumedVolumePerVendor,
        spend,
        cost_obs_id: c.obs_id,
        volume_obs_id: volRec.obs_id,
      };
    });

    const itemTotal = vendorRows.reduce((s, r) => s + r.spend, 0);
    const top = itemTotal > 0
      ? [...vendorRows].sort((a, b) => b.spend - a.spend)[0]
      : null;

    const notes: string[] = [];
    if (k > 1) {
      notes.push(
        `ASSUMPTION: VOLUME has no vendor split; assumed equal split across ${k} vendors for item ${item_id}.`
      );
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
      return {
        entity_id,
        entity_name: entityName.get(entity_id),
        total_spend: spend,
        spend_share: share,
        flag: (share > 0.5 ? "WARN" : share > 0.25 ? "NOTE" : "OK") as VendorExposure["flag"],
      };
    })
    .sort((a, b) => b.total_spend - a.total_spend);

  const notes: string[] = [];
  notes.push("v0 computes vendor exposure using UNIT_COST * VOLUME and equal vendor volume split when needed.");
  notes.push("This is a baseline-only risk view (no counterfactual simulation applied yet).");

  return {
    total_spend,
    vendor_exposure,
    item_exposure: item_exposure.sort((a, b) => a.item_id.localeCompare(b.item_id)),
    notes,
  };
}

/* ------------------------- helpers (deterministic) ------------------------- */

function latestVolumeByItem(
  d: ParsedDecision
): Map<string, { value: number; obs_id: string }> {
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

  const out = new Map<string, { value: number; obs_id: string }>();
  for (const [k, v] of m.entries()) out.set(k, { value: v.value, obs_id: v.obs_id });
  return out;
}

function latestCostByItemVendor(
  d: ParsedDecision
): Map<string, Map<string, { value: number; obs_id: string }>> {
  const m = new Map<
    string,
    Map<string, { t: number; value: number; obs_id: string }>
  >();

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

  const out = new Map<string, Map<string, { value: number; obs_id: string }>>();
  for (const [item, byVendor] of m.entries()) {
    const clean = new Map<string, { value: number; obs_id: string }>();
    for (const [vendor, rec] of byVendor.entries()) clean.set(vendor, { value: rec.value, obs_id: rec.obs_id });
    out.set(item, clean);
  }
  return out;
}

