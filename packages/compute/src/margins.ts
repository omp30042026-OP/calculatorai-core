import type { DecisionSnapshots, ItemSnapshot } from "../../simulate/src/snapshot.js";

export type MarginImpactRow = {
  item_id: string;

  baseline_unit_price?: number;
  baseline_unit_cost?: number;
  baseline_volume?: number;

  baseline_margin_per_unit?: number;
  baseline_total_margin?: number;

  simulated_unit_price?: number;
  simulated_margin_per_unit?: number;
  simulated_total_margin?: number;

  delta_total_margin?: number;

  trace: {
    used_observations: {
      unit_price?: string;
      unit_cost?: string;
      volume?: string;
    };
    applied_change_ids: string[];
    assumptions_used: string[];
  };

  notes: string[];
};

export function computeMarginImpactFromSnapshots(s: DecisionSnapshots): MarginImpactRow[] {
  const baselineByItem = new Map(s.baseline.map((r) => [r.item_id, r]));
  const simByItem = new Map(s.simulated.map((r) => [r.item_id, r]));

  const itemIds = [...new Set([...baselineByItem.keys(), ...simByItem.keys()])].sort((a, b) =>
    a.localeCompare(b)
  );

  const rows: MarginImpactRow[] = [];

  for (const item_id of itemIds) {
    const b = baselineByItem.get(item_id);
    const sim = simByItem.get(item_id);

    const notes: string[] = [];

    const bp = b?.metrics.unit_price.value;
    const bc = b?.metrics.unit_cost.value;
    const bv = b?.metrics.volume.value;

    if (bp == null) notes.push("Missing baseline UNIT_PRICE");
    if (bc == null) notes.push("Missing baseline UNIT_COST");
    if (bv == null) notes.push("Missing baseline VOLUME");

    const baseline_margin_per_unit = bp != null && bc != null ? bp - bc : undefined;
    const baseline_total_margin =
      baseline_margin_per_unit != null && bv != null ? baseline_margin_per_unit * bv : undefined;

    const sp = sim?.metrics.unit_price.value ?? bp;
    const sc = sim?.metrics.unit_cost.value ?? bc;
    const sv = sim?.metrics.volume.value ?? bv;

    const simulated_margin_per_unit =
        sp != null && sc != null ? sp - sc : undefined;

    const simulated_total_margin =
        simulated_margin_per_unit != null && sv != null
            ? simulated_margin_per_unit * sv
            : undefined;
    const delta_total_margin =
      simulated_total_margin != null && baseline_total_margin != null
        ? simulated_total_margin - baseline_total_margin
        : undefined;

    const applied_change_ids = uniq([
      ...(sim?.metrics.unit_price.applied_change_ids ?? []),
      ...(sim?.metrics.unit_cost.applied_change_ids ?? []),
      ...(sim?.metrics.volume.applied_change_ids ?? []),
    ]);

    rows.push({
      item_id,
      baseline_unit_price: bp,
      baseline_unit_cost: bc,
      baseline_volume: bv,
      baseline_margin_per_unit,
      baseline_total_margin,
      simulated_unit_price: sp,
      simulated_margin_per_unit,
      simulated_total_margin,
      delta_total_margin,
      trace: {
        used_observations: {
          unit_price: b?.metrics.unit_price.from_observation_id,
          unit_cost: b?.metrics.unit_cost.from_observation_id,
          volume: b?.metrics.volume.from_observation_id,
        },
        applied_change_ids,
        assumptions_used: [],
      },
      notes,
    });
  }

  return rows;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

