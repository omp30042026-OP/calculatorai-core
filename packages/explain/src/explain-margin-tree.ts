import type { ParsedDecision } from "../../cds/src/validate.js";
import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";
import type { MarginImpactRow } from "../../compute/src/margins.js";
import type { ExplainTree } from "./tree.js";

export function buildMarginExplainTrees(
  d: ParsedDecision,
  s: DecisionSnapshots,
  rows: MarginImpactRow[]
): ExplainTree[] {
  const baseByItem = new Map(s.baseline.map((x) => [x.item_id, x]));
  const simByItem = new Map(s.simulated.map((x) => [x.item_id, x]));
  const changeById = new Map(d.change_set.map((c) => [c.change_id, c]));
  const obsById = new Map(d.baseline.observations.map((o) => [o.obs_id, o]));

  return rows.map((r) => {
    const b = baseByItem.get(r.item_id);
    const sim = simByItem.get(r.item_id);

    const input = (
      metric: "UNIT_PRICE" | "UNIT_COST" | "VOLUME",
      obsId: string | undefined,
      val: number | undefined
    ) => {
      const o = obsId ? obsById.get(obsId) : undefined;
      return {
        metric,
        value: val ?? null,
        obs_id: obsId ?? null,
        quality: o?.quality
          ? {
              staleness_days: o.quality.staleness_days,
              completeness: o.quality.completeness,
              source_system: o.quality.source_system,
            }
          : undefined,
      };
    };

    const inputs: ExplainTree["inputs"] = [
      input("UNIT_PRICE", r.trace.used_observations.unit_price, r.baseline_unit_price),
      input("UNIT_COST", r.trace.used_observations.unit_cost, r.baseline_unit_cost),
      input("VOLUME", r.trace.used_observations.volume, r.baseline_volume),
    ];

    const appliedIds = [...r.trace.applied_change_ids].sort((a, b) => a.localeCompare(b));
    const changes: ExplainTree["changes"] = appliedIds.map((cid) => {
      const cs = changeById.get(cid);
      if (!cs) {
        return {
          change_id: cid,
          type: "UNKNOWN",
          target: "UNKNOWN",
          delta: { kind: "UNKNOWN" },
          status: "APPLIED",
        };
      }
      const target = cs.target.scope === "ITEM" ? `ITEM:${cs.target.item_id}` : cs.target.scope;
      return {
        change_id: cs.change_id,
        type: cs.type,
        target,
        delta: { ...cs.delta },
        status: "APPLIED",
      };
    });

    const sp = sim?.metrics.unit_price.value ?? b?.metrics.unit_price.value;
    const sc = sim?.metrics.unit_cost.value ?? b?.metrics.unit_cost.value;
    const sv = sim?.metrics.volume.value ?? b?.metrics.volume.value;

    const computations: ExplainTree["computations"] = [];

    computations.push({
      name: "baseline_total_margin",
      formula: "(price - cost) * volume",
      substituted: `(${fmt(r.baseline_unit_price)} - ${fmt(r.baseline_unit_cost)}) * ${fmt(
        r.baseline_volume
      )}`,
      value: r.baseline_total_margin ?? null,
    });

    computations.push({
      name: "simulated_total_margin",
      formula: "(price - cost) * volume",
      substituted: `(${fmt(sp)} - ${fmt(sc)}) * ${fmt(sv)}`,
      value: r.simulated_total_margin ?? null,
    });

    computations.push({
      name: "delta_total_margin",
      formula: "simulated_total_margin - baseline_total_margin",
      substituted: `${fmt(r.simulated_total_margin)} - ${fmt(r.baseline_total_margin)}`,
      value: r.delta_total_margin ?? null,
    });

    const notes: string[] = [...r.notes];

    for (const inp of inputs) {
      if (inp.quality?.staleness_days != null) {
        if (inp.quality.staleness_days > 30)
          notes.push(`WARN: ${inp.metric} is stale (${inp.quality.staleness_days} days)`);
        else if (inp.quality.staleness_days > 7)
          notes.push(`NOTE: ${inp.metric} is ${inp.quality.staleness_days} days old`);
      }
      if (inp.quality?.completeness != null) {
        if (inp.quality.completeness < 0.8)
          notes.push(`WARN: ${inp.metric} completeness low (${inp.quality.completeness})`);
        else if (inp.quality.completeness < 1)
          notes.push(`NOTE: ${inp.metric} completeness ${inp.quality.completeness}`);
      }
      if (inp.obs_id && inp.obs_id.startsWith("AGG:")) {
        notes.push(`NOTE: ${inp.metric} is aggregated (${inp.obs_id}).`);
      }
    }

    return {
      item_id: r.item_id,
      inputs,
      changes,
      computations,
      result: {
        baseline_total_margin: r.baseline_total_margin ?? null,
        simulated_total_margin: r.simulated_total_margin ?? null,
        delta_total_margin: r.delta_total_margin ?? null,
      },
      notes,
    };
  });
}

function fmt(n: number | undefined | null): string {
  return n == null ? "null" : Number.isFinite(n) ? String(n) : "NaN";
}

