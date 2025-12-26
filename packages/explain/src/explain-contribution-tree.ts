import type { ExplainTree } from "./tree.js";
import type { ContributionRow } from "../../compute/src/contribution.js";

type Computation = ExplainTree["computations"][number];

export function attachContributionToTrees(
  trees: ExplainTree[],
  contribRows: ContributionRow[]
): ExplainTree[] {
  const byItem = new Map(contribRows.map((r) => [r.item_id, r]));

  return trees.map((t) => {
    const c: any = byItem.get(t.item_id);
    if (!c) return t;

    const bp: number | null = numOrNull(c.bp);
    const bc: number | null = numOrNull(c.bc);
    const bv: number | null = numOrNull(c.bv);
    const sp: number | null = numOrNull(c.sp);
    const sc: number | null = numOrNull(c.sc);
    const sv: number | null = numOrNull(c.sv);

    // v5.2: patched substituted for baseline/sim/delta (rounded display)
    const patched = t.computations.map((row) => {
      if (row.name === "baseline_total_margin") {
        return {
          ...row,
          substituted:
            bp != null && bc != null && bv != null
              ? `(${fmtDisplay(bp)} - ${fmtDisplay(bc)}) * ${fmtDisplay(bv)}`
              : row.substituted,
        };
      }

      if (row.name === "simulated_total_margin") {
        return {
          ...row,
          substituted:
            sp != null && sc != null && sv != null
              ? `(${fmtDisplay(sp)} - ${fmtDisplay(sc)}) * ${fmtDisplay(sv)}`
              : row.substituted,
        };
      }

      if (row.name === "delta_total_margin") {
        return {
          ...row,
          substituted:
            c.simulated_total_margin != null && c.baseline_total_margin != null
              ? `${fmtDisplay(c.simulated_total_margin)} - ${fmtDisplay(
                  c.baseline_total_margin
                )}`
              : row.substituted,
        };
      }

      return row;
    });

    // v7: expected unit price should be explainable from tree meta
    const expected = buildExpectedUnitPriceRow(t, c);

    // v6: driver + recommendation
    const drivers = [
      { name: "price", v: absOrNull(c.price_effect) },
      { name: "cost", v: absOrNull(c.cost_effect) },
      { name: "volume", v: absOrNull(c.volume_effect) },
    ].filter((x) => x.v != null) as Array<{ name: string; v: number }>;

    drivers.sort((a, b) => b.v - a.v);
    const primary = drivers.length > 0 ? drivers[0]!.name : "unknown";

    const rec =
      primary === "price"
        ? "Pricing is the dominant margin lever"
        : primary === "cost"
        ? "Cost reduction is the dominant margin lever"
        : primary === "volume"
        ? "Volume is the dominant margin lever"
        : "No dominant lever identified";

    // Baseline margin used for elasticity denominators
    const baselineMargin: number | null =
      numOrNull(c.baseline_total_margin) ??
      numOrNull(
        t.result?.baseline_total_margin ??
          t.computations.find((x) => x.name === "baseline_total_margin")?.value
      );

    // v7.2: sensitivities (1% bumps around simulated point)
    const priceSensitivity1pct =
      sp != null && sv != null ? 0.01 * sp * sv : null;
    const costSensitivity1pct =
      sc != null && sv != null ? -0.01 * sc * sv : null;
    const volumeSensitivity1pct =
      sv != null && sp != null && sc != null ? 0.01 * sv * (sp - sc) : null;

    // v7.2: elasticities (normalize effects by baseline margin)
    const priceElasticity =
      numOrNull(c.price_effect) != null && baselineMargin != null && baselineMargin !== 0
        ? (numOrNull(c.price_effect)! / baselineMargin)
        : null;

    const costElasticity =
      numOrNull(c.cost_effect) != null && baselineMargin != null && baselineMargin !== 0
        ? (numOrNull(c.cost_effect)! / baselineMargin)
        : null;

    const volumeElasticity =
      numOrNull(c.volume_effect) != null && baselineMargin != null && baselineMargin !== 0
        ? (numOrNull(c.volume_effect)! / baselineMargin)
        : null;

    const extra: Computation[] = [
      expected,

      {
        name: "price_effect",
        formula: "(sp - bp) * bv",
        substituted:
          sp != null && bp != null && bv != null
            ? `(${fmtDisplay(sp)} - ${fmtDisplay(bp)}) * ${fmtDisplay(bv)}`
            : "null (computed)",
        value: numOrNull(c.price_effect),
      },
      {
        name: "cost_effect",
        formula: "-(sc - bc) * bv",
        substituted:
          sc != null && bc != null && bv != null
            ? `-(${fmtDisplay(sc)} - ${fmtDisplay(bc)}) * ${fmtDisplay(bv)}`
            : "null (computed)",
        value: numOrNull(c.cost_effect),
      },
      {
        name: "volume_effect",
        formula: "(sv - bv) * (bp - bc)",
        substituted:
          sv != null && bv != null && bp != null && bc != null
            ? `(${fmtDisplay(sv)} - ${fmtDisplay(bv)}) * (${fmtDisplay(bp)} - ${fmtDisplay(bc)})`
            : "null (computed)",
        value: numOrNull(c.volume_effect),
      },
      {
        name: "interaction_effect",
        formula: "delta - (price_effect + cost_effect + volume_effect)",
        substituted:
          c.delta_total_margin != null &&
          c.price_effect != null &&
          c.cost_effect != null &&
          c.volume_effect != null
            ? `${fmtDisplay(numOrNull(c.delta_total_margin))} - (${fmtDisplay(
                numOrNull(c.price_effect)
              )} + ${fmtDisplay(numOrNull(c.cost_effect))} + ${fmtDisplay(
                numOrNull(c.volume_effect)
              )})`
            : "null (computed)",
        value: numOrNull(c.interaction_effect),
      },

      // ---------------- v7.2 additions ----------------
      {
        name: "price_sensitivity_1pct",
        formula: "0.01 * sp * sv",
        substituted:
          sp != null && sv != null
            ? `0.01 * ${fmtDisplay(sp)} * ${fmtDisplay(sv)}`
            : "null (computed)",
        value: priceSensitivity1pct,
      },
      {
        name: "cost_sensitivity_1pct",
        formula: "-0.01 * sc * sv",
        substituted:
          sc != null && sv != null
            ? `-0.01 * ${fmtDisplay(sc)} * ${fmtDisplay(sv)}`
            : "null (computed)",
        value: costSensitivity1pct,
      },
      {
        name: "volume_sensitivity_1pct",
        formula: "0.01 * sv * (sp - sc)",
        substituted:
          sv != null && sp != null && sc != null
            ? `0.01 * ${fmtDisplay(sv)} * (${fmtDisplay(sp)} - ${fmtDisplay(sc)})`
            : "null (computed)",
        value: volumeSensitivity1pct,
      },
      {
        name: "price_elasticity",
        formula: "price_effect / baseline_total_margin",
        substituted:
          numOrNull(c.price_effect) != null && baselineMargin != null
            ? `${fmtDisplay(numOrNull(c.price_effect))} / ${fmtDisplay(baselineMargin)}`
            : "null (computed)",
        value: priceElasticity,
      },
      {
        name: "cost_elasticity",
        formula: "cost_effect / baseline_total_margin",
        substituted:
          numOrNull(c.cost_effect) != null && baselineMargin != null
            ? `${fmtDisplay(numOrNull(c.cost_effect))} / ${fmtDisplay(baselineMargin)}`
            : "null (computed)",
        value: costElasticity,
      },
      {
        name: "volume_elasticity",
        formula: "volume_effect / baseline_total_margin",
        substituted:
          numOrNull(c.volume_effect) != null && baselineMargin != null
            ? `${fmtDisplay(numOrNull(c.volume_effect))} / ${fmtDisplay(baselineMargin)}`
            : "null (computed)",
        value: volumeElasticity,
      },
      // ------------------------------------------------

      {
        name: "primary_margin_driver",
        formula: "argmax(|price|, |cost|, |volume|)",
        substituted: primary,
        value: null,
      },
      {
        name: "recommendation",
        formula: "interpret(primary_margin_driver)",
        substituted: rec,
        value: null,
      },
    ];

    const merged = upsertComputations(patched, extra);
    return { ...t, computations: merged };
  });
}

/* ---------------------------- v7: expected price ---------------------------- */

function buildExpectedUnitPriceRow(t: ExplainTree, c: any): Computation {
  // bp: prefer contrib row if present, otherwise read from tree baseline inputs
  const bpFromInputs =
    t.inputs.find((x) => x.metric === "UNIT_PRICE")?.value ?? null;

  const bp =
    typeof c?.bp === "number" && Number.isFinite(c.bp) ? c.bp : bpFromInputs;

  const abs = getAbsolutePriceFromChanges(t);
  const af = getActiveFractionSmart(t);

  const value =
    bp != null && af != null && abs != null ? bp * (1 - af) + abs * af : null;

  const substituted =
    bp == null
      ? "null (missing bp)"
      : abs == null && af == null
      ? `${fmtDisplay(bp)}*(1-?) + ?*(?) (missing abs_price/active_fraction)`
      : abs == null
      ? `${fmtDisplay(bp)}*(1-${fmtDisplay(af)}) + ?*(${fmtDisplay(af)}) (missing abs_price)`
      : af == null
      ? `${fmtDisplay(bp)}*(1-?) + ${fmtDisplay(abs)}*(?) (missing active_fraction)`
      : `${fmtDisplay(bp)}*(1-${fmtDisplay(af)}) + ${fmtDisplay(abs)}*(${fmtDisplay(af)})`;

  return {
    name: "expected_unit_price",
    formula: "bp*(1-active_fraction) + abs_price*(active_fraction)",
    substituted,
    value,
  };
}

/**
 * v7.3: Robust active_fraction extraction
 * Priority:
 *  1) APPLIED ABSOLUTE PRICE_CHANGE meta.time_gating.active_fraction
 *  2) ANY ABSOLUTE PRICE_CHANGE meta.time_gating.active_fraction
 *  3) ANY change meta.time_gating.active_fraction
 * Fallback:
 *  4) derive from overlap/horizon windows (end-start)/(end-start)
 * Accepts 0 as valid.
 */
function getActiveFractionSmart(t: ExplainTree): number | null {
  const changes = t.changes as any[];

  const readMetaAf = (ch: any): number | null => {
    const v =
      ch?.meta?.time_gating?.active_fraction ??
      ch?.meta?.time_gating?.activeFraction ??
      ch?.meta?.timeGating?.active_fraction ??
      ch?.meta?.timeGating?.activeFraction;

    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const deriveFromWindows = (ch: any): number | null => {
    const tg = ch?.meta?.time_gating ?? ch?.meta?.timeGating;
    const overlap = tg?.overlap;
    const horizon = tg?.horizon;
    const o0 = Date.parse(overlap?.start);
    const o1 = Date.parse(overlap?.end);
    const h0 = Date.parse(horizon?.start);
    const h1 = Date.parse(horizon?.end);

    if (![o0, o1, h0, h1].every((x) => Number.isFinite(x))) return null;
    const overlapMs = Math.max(0, o1 - o0);
    const horizonMs = Math.max(0, h1 - h0);
    if (horizonMs <= 0) return null;

    const af = overlapMs / horizonMs;
    // clamp just in case of boundary/timezone quirks
    return Math.max(0, Math.min(1, af));
  };

  // 1) Prefer APPLIED ABSOLUTE price change
  for (const ch of changes) {
    if (
      ch?.type === "PRICE_CHANGE" &&
      ch?.delta?.kind === "ABSOLUTE" &&
      ch?.status === "APPLIED"
    ) {
      const af = readMetaAf(ch) ?? deriveFromWindows(ch);
      if (af != null) return af;
    }
  }

  // 2) Any ABSOLUTE price change
  for (const ch of changes) {
    if (ch?.type === "PRICE_CHANGE" && ch?.delta?.kind === "ABSOLUTE") {
      const af = readMetaAf(ch) ?? deriveFromWindows(ch);
      if (af != null) return af;
    }
  }

  // 3) Any change
  for (const ch of changes) {
    const af = readMetaAf(ch) ?? deriveFromWindows(ch);
    if (af != null) return af;
  }

  return null;
}



function getAbsolutePriceFromChanges(t: ExplainTree): number | null {
  const abs = (t.changes as any[])
    .filter((ch) => ch?.type === "PRICE_CHANGE")
    .filter((ch) => ch?.delta?.kind === "ABSOLUTE")
    .filter(
      (ch) =>
        typeof ch?.delta?.new_value === "number" &&
        Number.isFinite(ch.delta.new_value)
    );

  if (abs.length === 0) return null;

  const applied = abs.filter((ch) => ch?.status === "APPLIED");
  const pick = applied.length ? applied : abs;

  // deterministic: last by change_id
  const sorted = [...pick].sort((a, b) =>
    String(a.change_id).localeCompare(String(b.change_id))
  );
  return sorted[sorted.length - 1]!.delta.new_value as number;
}

/* ---------------------------- utils ---------------------------- */

function upsertComputations(
  existing: Computation[],
  add: Computation[]
): Computation[] {
  const byName = new Map(existing.map((r) => [r.name, r]));
  for (const r of add) byName.set(r.name, r);

  const existingNames = new Set(existing.map((r) => r.name));
  const appended = add
    .filter((r) => !existingNames.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rebuilt = existing.map((r) => byName.get(r.name)!);
  return [...rebuilt, ...appended];
}

function fmtDisplay(n: number | undefined | null): string {
  if (n == null) return "null";
  if (!Number.isFinite(n)) return "NaN";
  const isInt = Math.abs(n - Math.round(n)) < 1e-12;
  return isInt ? String(Math.round(n)) : n.toFixed(2);
}

function numOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function absOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? Math.abs(x) : null;
}
