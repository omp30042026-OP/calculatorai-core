import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";

export type MarginImpactRow = {
  item_id: string;

  baseline_unit_price?: number;
  baseline_unit_cost?: number;
  baseline_volume?: number;

  baseline_margin_per_unit?: number;
  baseline_total_margin?: number;

  simulated_unit_price?: number;
  simulated_unit_cost?: number;
  simulated_volume?: number;

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

  // ---- compatibility fields expected by explain + assert-effects ----
  bp?: number | null;
  bc?: number | null;
  bv?: number | null;

  sp?: number | null;
  sc?: number | null;
  sv?: number | null;

  price_effect?: number | null;
  cost_effect?: number | null;
  volume_effect?: number | null;
  interaction_effect?: number | null;
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

    const simulated_margin_per_unit = sp != null && sc != null ? sp - sc : undefined;

    const simulated_total_margin =
      simulated_margin_per_unit != null && sv != null ? simulated_margin_per_unit * sv : undefined;

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
      simulated_unit_cost: sc,
      simulated_volume: sv,

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

  // Add compatibility aliases + effects expected by explain + assert-effects
  function withAliasesAndEffects(r: MarginImpactRow): MarginImpactRow {
    const bp = typeof r.baseline_unit_price === "number" ? r.baseline_unit_price : null;
    const bc = typeof r.baseline_unit_cost === "number" ? r.baseline_unit_cost : null;
    const bv = typeof r.baseline_volume === "number" ? r.baseline_volume : null;

    const sp = typeof r.simulated_unit_price === "number" ? r.simulated_unit_price : bp;
    const sc = typeof r.simulated_unit_cost === "number" ? r.simulated_unit_cost : bc;
    const sv = typeof r.simulated_volume === "number" ? r.simulated_volume : bv;

    // ensure totals exist (some callers only rely on these)
    const baseline_total_margin =
      typeof r.baseline_total_margin === "number"
        ? r.baseline_total_margin
        : bp != null && bc != null && bv != null
        ? (bp - bc) * bv
        : undefined;

    const simulated_total_margin =
      typeof r.simulated_total_margin === "number"
        ? r.simulated_total_margin
        : sp != null && sc != null && sv != null
        ? (sp - sc) * sv
        : undefined;

    const delta_total_margin =
      typeof r.delta_total_margin === "number"
        ? r.delta_total_margin
        : simulated_total_margin != null && baseline_total_margin != null
        ? simulated_total_margin - baseline_total_margin
        : undefined;

    // 3-way decomposition effects
    const price_effect = sp != null && bp != null && bv != null ? (sp - bp) * bv : null;

    const cost_effect = sc != null && bc != null && bv != null ? -(sc - bc) * bv : null;

    const volume_effect =
      sv != null && bv != null && bp != null && bc != null ? (sv - bv) * (bp - bc) : null;

    const interaction_effect =
      delta_total_margin != null &&
      price_effect != null &&
      cost_effect != null &&
      volume_effect != null
        ? delta_total_margin - (price_effect + cost_effect + volume_effect)
        : null;

    return {
      ...r,

      // keep “real” totals if present, else computed
      baseline_total_margin,
      simulated_total_margin,
      delta_total_margin,

      // aliases
      bp,
      bc,
      bv,
      sp,
      sc,
      sv,

      // effects
      price_effect,
      cost_effect,
      volume_effect,
      interaction_effect,
    };
  }

  return rows.map(withAliasesAndEffects);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

