import type { ExplainTree } from "./tree.js";
import type { ConcentrationDeltaReport } from "../../risk/src/concentration-v1.js";

export function attachConcentrationDeltaToTrees(
  trees: ExplainTree[],
  delta: ConcentrationDeltaReport
): ExplainTree[] {
  const byItem = new Map(delta.items.map((x) => [x.item_id, x]));

  return trees.map((t) => {
    const d = byItem.get(t.item_id);
    if (!d) return t;

    const computations = [...t.computations];

    computations.push({
      name: "baseline_top_vendor_share",
      formula: "top_vendor_spend / item_total_spend (baseline)",
      substituted:
        d.baseline_top_vendor_share == null
          ? "null"
          : String(d.baseline_top_vendor_share),
      value: d.baseline_top_vendor_share,
    });

    computations.push({
      name: "simulated_top_vendor_share",
      formula: "top_vendor_spend / item_total_spend (simulated)",
      substituted:
        d.simulated_top_vendor_share == null
          ? "null"
          : String(d.simulated_top_vendor_share),
      value: d.simulated_top_vendor_share,
    });

    computations.push({
      name: "delta_top_vendor_share",
      formula: "simulated_top_vendor_share - baseline_top_vendor_share",
      substituted:
        d.delta_top_vendor_share == null ? "null" : String(d.delta_top_vendor_share),
      value: d.delta_top_vendor_share,
    });

    const notes = [...t.notes];

    // Always emit a deterministic note for delta (even if tiny)
    if (d.delta_top_vendor_share == null) {
      notes.push("NOTE: Concentration delta unavailable for this item.");
    } else {
      const pctPts = Math.round(d.delta_top_vendor_share * 10000) / 100; // percentage points

      if (d.delta_top_vendor_share > 0.02) {
        notes.push(`WARN: Concentration increased by ${pctPts} percentage points.`);
      } else if (d.delta_top_vendor_share > 0.005) {
        notes.push(`NOTE: Concentration increased by ${pctPts} percentage points.`);
      } else if (d.delta_top_vendor_share < -0.005) {
        notes.push(`NOTE: Concentration decreased by ${Math.abs(pctPts)} percentage points.`);
      } else {
        notes.push(`NOTE: Concentration change is small (${pctPts} percentage points).`);
      }
    }

    return { ...t, computations, notes };
  });
}

