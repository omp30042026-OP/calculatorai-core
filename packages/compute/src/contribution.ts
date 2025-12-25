import type { DecisionSnapshots, ItemSnapshot } from "../../simulate/src/snapshot.js";

export type ContributionRow = {
  item_id: string;

  // expose the underlying inputs so explain can build substituted strings consistently
  bp: number | null;
  bc: number | null;
  bv: number | null;

  sp: number | null;
  sc: number | null;
  sv: number | null;

  baseline_total_margin: number | null;
  simulated_total_margin: number | null;
  delta_total_margin: number | null;

  price_effect: number | null;
  cost_effect: number | null;
  volume_effect: number | null;
  interaction_effect: number | null;
};

/**
 * Contribution decomposition (v5):
 * - Uses snapshots as the source of truth.
 * - If time-gating produces horizon-weighted expected metric values in `simulated`,
 *   this function decomposes *that expected outcome*.
 *
 * Formula (classic 3-factor with interaction):
 *  baseline = (bp - bc) * bv
 *  simulated = (sp - sc) * sv
 *  delta = simulated - baseline
 *
 *  price_effect  = (sp - bp) * bv
 *  cost_effect   = -(sc - bc) * bv
 *  volume_effect = (sv - bv) * (bp - bc)
 *  interaction   = delta - (price_effect + cost_effect + volume_effect)
 */
export function computeContributionFromSnapshots(s: DecisionSnapshots): ContributionRow[] {
  const baseIndex = new Map<string, ItemSnapshot>();
  for (const b of s.baseline) baseIndex.set(b.item_id, b);

  const out: ContributionRow[] = [];

  // deterministic order
  const simSorted = [...s.simulated].sort((a, b) => a.item_id.localeCompare(b.item_id));

  for (const sim of simSorted) {
    const base = baseIndex.get(sim.item_id);
    if (!base) continue;

    const bp = numOrNull(base.metrics.unit_price.value);
    const bc = numOrNull(base.metrics.unit_cost.value);
    const bv = numOrNull(base.metrics.volume.value);

    const sp = numOrNull(sim.metrics.unit_price.value);
    const sc = numOrNull(sim.metrics.unit_cost.value);
    const sv = numOrNull(sim.metrics.volume.value);

    const baseline_total_margin =
      bp != null && bc != null && bv != null ? (bp - bc) * bv : null;

    const simulated_total_margin =
      sp != null && sc != null && sv != null ? (sp - sc) * sv : null;

    const delta_total_margin =
      simulated_total_margin != null && baseline_total_margin != null
        ? simulated_total_margin - baseline_total_margin
        : null;

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

    out.push({
      item_id: sim.item_id,

      bp,
      bc,
      bv,
      sp,
      sc,
      sv,

      baseline_total_margin,
      simulated_total_margin,
      delta_total_margin,

      price_effect,
      cost_effect,
      volume_effect,
      interaction_effect,
    });
  }

  return out;
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

