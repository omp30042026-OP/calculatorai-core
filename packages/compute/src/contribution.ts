import type { DecisionSnapshots } from "../../simulate/src/snapshot.js";

export type ContributionRow = {
  item_id: string;

  // baseline
  bp: number | null;
  bc: number | null;
  bv: number | null;
  baseline_total_margin: number | null;

  // simulated
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

    const bp = numOrNull(b?.metrics?.unit_price?.value);
    const bc = numOrNull(b?.metrics?.unit_cost?.value);
    const bv = numOrNull(b?.metrics?.volume?.value);

    // Use simulated if present; fallback to baseline like your margins.ts
    const sp = numOrNull(sim?.metrics?.unit_price?.value ?? bp);
    const sc = numOrNull(sim?.metrics?.unit_cost?.value ?? bc);
    const sv = numOrNull(sim?.metrics?.volume?.value ?? bv);

    const baseline_total_margin =
      bp != null && bc != null && bv != null ? (bp - bc) * bv : null;

    const simulated_total_margin =
      sp != null && sc != null && sv != null ? (sp - sc) * sv : null;

    const delta_total_margin =
      simulated_total_margin != null && baseline_total_margin != null
        ? simulated_total_margin - baseline_total_margin
        : null;

    // Standard 3-way decomposition (same formulas you’re already using in explain)
    const price_effect =
      sp != null && bp != null && bv != null ? (sp - bp) * bv : null;

    const cost_effect =
      sc != null && bc != null && bv != null ? -(sc - bc) * bv : null;

    const volume_effect =
      sv != null && bv != null && bp != null && bc != null ? (sv - bv) * (bp - bc) : null;

    const interaction_effect =
      delta_total_margin != null &&
      price_effect != null &&
      cost_effect != null &&
      volume_effect != null
        ? delta_total_margin - (price_effect + cost_effect + volume_effect)
        : null;

    rows.push({
      item_id,
      bp,
      bc,
      bv,
      baseline_total_margin,
      sp,
      sc,
      sv,
      simulated_total_margin,
      delta_total_margin,
      price_effect,
      cost_effect,
      volume_effect,
      interaction_effect,
    });
  }

  return rows;
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
