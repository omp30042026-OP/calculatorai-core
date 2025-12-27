import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";

export type ContributionRow = {
  item_id: string;

  // ---------- expanded (new/compat for other tooling) ----------
  baseline_unit_price: number | null;
  baseline_unit_cost: number | null;
  baseline_volume: number | null;
  baseline_margin_per_unit: number | null;

  simulated_unit_price: number | null;
  simulated_unit_cost: number | null;
  simulated_volume: number | null;
  simulated_margin_per_unit: number | null;
  // ------------------------------------------------------------

  // baseline (short aliases used by explain layer + assert-effects)
  bp: number | null;
  bc: number | null;
  bv: number | null;
  baseline_total_margin: number | null;

  // simulated (short aliases used by explain layer + assert-effects)
  sp: number | null;
  sc: number | null;
  sv: number | null;
  simulated_total_margin: number | null;

  // effects
  price_effect: number | null;
  cost_effect: number | null;
  volume_effect: number | null;
  interaction_effect: number | null;

  delta_total_margin: number | null;

  // optional debugging surface (safe for old consumers)
  notes?: string[];
};

export function computeContributionFromSnapshots(s: DecisionSnapshots): ContributionRow[] {
  const baselineByItem = new Map(s.baseline.map((r) => [r.item_id, r]));
  const simByItem = new Map(s.simulated.map((r) => [r.item_id, r]));

  const itemIds = [...new Set([...baselineByItem.keys(), ...simByItem.keys()])].sort((a, b) =>
    a.localeCompare(b)
  );

  const rows: ContributionRow[] = [];

  for (const item_id of itemIds) {
    const b = baselineByItem.get(item_id);
    const sim = simByItem.get(item_id);

    const notes: string[] = [];

    const baseline_unit_price = numOrNull(b?.metrics?.unit_price?.value);
    const baseline_unit_cost = numOrNull(b?.metrics?.unit_cost?.value);
    const baseline_volume = numOrNull(b?.metrics?.volume?.value);

    // Use simulated if present; fallback to baseline (matches your earlier intent)
    const simulated_unit_price = numOrNull(sim?.metrics?.unit_price?.value ?? baseline_unit_price);
    const simulated_unit_cost = numOrNull(sim?.metrics?.unit_cost?.value ?? baseline_unit_cost);
    const simulated_volume = numOrNull(sim?.metrics?.volume?.value ?? baseline_volume);

    // Margin per unit
    const baseline_margin_per_unit =
      baseline_unit_price != null && baseline_unit_cost != null
        ? baseline_unit_price - baseline_unit_cost
        : null;

    const simulated_margin_per_unit =
      simulated_unit_price != null && simulated_unit_cost != null
        ? simulated_unit_price - simulated_unit_cost
        : null;

    // Short alias fields expected by explain layer + assert-effects
    const bp = baseline_unit_price;
    const bc = baseline_unit_cost;
    const bv = baseline_volume;

    const sp = simulated_unit_price;
    const sc = simulated_unit_cost;
    const sv = simulated_volume;

    const baseline_total_margin =
      bp != null && bc != null && bv != null ? (bp - bc) * bv : null;

    const simulated_total_margin =
      sp != null && sc != null && sv != null ? (sp - sc) * sv : null;

    const delta_total_margin =
      simulated_total_margin != null && baseline_total_margin != null
        ? simulated_total_margin - baseline_total_margin
        : null;

    // 3-way decomposition (standard)
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

    // Helpful notes if something is missing
    if (bp == null) notes.push("missing baseline_unit_price");
    if (bc == null) notes.push("missing baseline_unit_cost");
    if (bv == null) notes.push("missing baseline_volume");

    rows.push({
      item_id,

      // expanded
      baseline_unit_price,
      baseline_unit_cost,
      baseline_volume,
      baseline_margin_per_unit,

      simulated_unit_price,
      simulated_unit_cost,
      simulated_volume,
      simulated_margin_per_unit,

      // aliases
      bp,
      bc,
      bv,
      baseline_total_margin,
      sp,
      sc,
      sv,
      simulated_total_margin,

      // totals + effects
      delta_total_margin,
      price_effect,
      cost_effect,
      volume_effect,
      interaction_effect,

      // optional
      notes: notes.length ? notes : undefined,
    });
  }

  return rows;
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

