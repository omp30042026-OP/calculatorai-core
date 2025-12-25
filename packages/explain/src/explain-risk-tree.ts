import type { ExplainTree } from "./tree.js";
import type { ConcentrationRiskReport } from "../../risk/src/concentration.js";

export function attachConcentrationRiskToTrees(
  trees: ExplainTree[],
  report: ConcentrationRiskReport
): ExplainTree[] {
  const itemById = new Map(report.item_exposure.map((x) => [x.item_id, x]));

  return trees.map((t) => {
    const ie = itemById.get(t.item_id);
    if (!ie) return t;

    const extraNotes: string[] = [];
    extraNotes.push("RISK(v0): concentration computed from baseline UNIT_COST * VOLUME.");
    for (const n of ie.notes) extraNotes.push(n);

    if (ie.top_vendor) {
      const share = ie.top_vendor.spend_share_of_item;
      const pct = Math.round(share * 1000) / 10;

      const flag = share > 0.5 ? "WARN" : share > 0.25 ? "NOTE" : "OK";
      extraNotes.push(
        `${flag}: Top vendor concentration for item ${t.item_id} is ${pct}% (${ie.top_vendor.entity_id}${ie.top_vendor.entity_name ? " / " + ie.top_vendor.entity_name : ""}).`
      );
    } else {
      extraNotes.push("NOTE: No top vendor computed (missing vendor-level UNIT_COST observations).");
    }

    const extraComputations = [
      {
        name: "baseline_total_spend_estimate",
        formula: "Σ(unit_cost_vendor * assumed_volume_vendor)",
        substituted: String(report.total_spend),
        value: report.total_spend,
      },
      {
        name: "top_vendor_spend_share_of_item",
        formula: "top_vendor_spend / item_total_spend",
        substituted: ie.top_vendor ? String(ie.top_vendor.spend_share_of_item) : "null",
        value: ie.top_vendor ? ie.top_vendor.spend_share_of_item : null,
      },
    ];

    return {
      ...t,
      computations: [...t.computations, ...extraComputations],
      notes: [...t.notes, ...extraNotes],
    };
  });
}
