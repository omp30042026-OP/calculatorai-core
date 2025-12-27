import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { attachContributionToTrees } from "../packages/explain/src/explain-contribution-tree";
import { computeMarginImpactFromSnapshots } from "../packages/compute/src/margins";
import { buildDecisionSnapshots } from "../packages/simulate/src/snapshot";

function loadJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJsonOnly(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function pickDecisionPath(): string {
  const arg = process.argv[2];
  if (arg) return arg;

  const preferred = [
    "examples/decisions/single-item.json",
    "examples/decisions/single.json",
    "examples/decisions/decision.json",
    "examples/decisions/tree.json",
    "examples/decisions/multi-item.json",
    "examples/decisions/multi.json",
  ];
  const hit = preferred.find((p) => existsSync(p));
  if (hit) return hit;

  const dir = "examples/decisions";
  if (!existsSync(dir)) {
    throw new Error(
      `Missing directory: ${dir}\nRun like: npx tsx examples/run-explain-tree.ts <path-to-decision.json>`
    );
  }

  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort((a, b) => a.localeCompare(b));

  if (candidates.length === 0) {
    throw new Error(
      `No decision JSON found in ${dir}\nRun like: npx tsx examples/run-explain-tree.ts <path-to-decision.json>`
    );
  }
  return candidates[0]!;
}

function num(x: any): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function fmt(n: number | null): string {
  if (n == null) return "null";
  const isInt = Math.abs(n - Math.round(n)) < 1e-12;
  return isInt ? String(Math.round(n)) : n.toFixed(2);
}

function enrichTreesWithSnapshotAndTotals(
  baseTrees: any[],
  snaps: any,
  contribRows: any[]
) {
  const byItem = new Map<string, any>();
  for (const r of contribRows ?? []) {
    if (r?.item_id) byItem.set(String(r.item_id), r);
  }

  return (baseTrees ?? []).map((t: any) => {
    const itemId = String(t?.item_id ?? "");
    const c = byItem.get(itemId);

    const baselineRows = Array.isArray(snaps?.baseline) ? snaps.baseline : [];
    const inputs = baselineRows
      .filter((r: any) => String(r?.item_id) === itemId)
      .filter((r: any) =>
        ["UNIT_PRICE", "UNIT_COST", "VOLUME"].includes(String(r?.metric))
      )
      .map((r: any) => ({
        metric: r.metric,
        value: r.value,
        obs_id: r.obs_id,
        quality: r.quality,
      }));

    const baselineTotal =
      num(c?.baseline_total_margin) ?? num(c?.baselineTotalMargin) ?? null;
    const simulatedTotal =
      num(c?.simulated_total_margin) ?? num(c?.simulatedTotalMargin) ?? null;
    const deltaTotal =
      num(c?.delta_total_margin) ?? num(c?.deltaTotalMargin) ?? null;

    const bp = num(c?.bp) ?? num(c?.baseline_unit_price) ?? null;
    const bc = num(c?.bc) ?? num(c?.baseline_unit_cost) ?? null;
    const bv = num(c?.bv) ?? num(c?.baseline_volume) ?? null;
    const sp = num(c?.sp) ?? num(c?.simulated_unit_price) ?? null;
    const sc = num(c?.sc) ?? num(c?.simulated_unit_cost) ?? null;
    const sv = num(c?.sv) ?? num(c?.simulated_volume) ?? null;

    const existing = Array.isArray(t?.computations) ? t.computations : [];

    const upsert = (rows: any[], row: any) => {
      const i = rows.findIndex((x) => x?.name === row?.name);
      if (i >= 0) {
        const copy = rows.slice();
        copy[i] = { ...rows[i], ...row };
        return copy;
      }
      return [...rows, row];
    };

    let computations = existing;

    computations = upsert(computations, {
      name: "baseline_total_margin",
      formula: "(price - cost) * volume",
      substituted:
        bp != null && bc != null && bv != null
          ? `(${fmt(bp)} - ${fmt(bc)}) * ${fmt(bv)}`
          : "(price - cost) * volume",
      value: baselineTotal,
    });

    computations = upsert(computations, {
      name: "simulated_total_margin",
      formula: "(price - cost) * volume",
      substituted:
        sp != null && sc != null && sv != null
          ? `(${fmt(sp)} - ${fmt(sc)}) * ${fmt(sv)}`
          : "(price - cost) * volume",
      value: simulatedTotal,
    });

    computations = upsert(computations, {
      name: "delta_total_margin",
      formula: "simulated_total_margin - baseline_total_margin",
      substituted:
        simulatedTotal != null && baselineTotal != null
          ? `${fmt(simulatedTotal)} - ${fmt(baselineTotal)}`
          : "simulated_total_margin - baseline_total_margin",
      value: deltaTotal,
    });

    const result = {
      ...(t?.result ?? {}),
      ...(baselineTotal != null ? { baseline_total_margin: baselineTotal } : {}),
      ...(simulatedTotal != null
        ? { simulated_total_margin: simulatedTotal }
        : {}),
      ...(deltaTotal != null ? { delta_total_margin: deltaTotal } : {}),
    };

    return { ...t, inputs, computations, result };
  });
}

const decisionPath = pickDecisionPath();
const decision = loadJson(decisionPath);

const snaps = buildDecisionSnapshots(decision);
const contribRows = computeMarginImpactFromSnapshots(snaps);

const itemIds = Array.from(
  new Set(
    [...(snaps?.baseline ?? []), ...(snaps?.simulated ?? [])].map(
      (r: any) => r.item_id
    )
  )
).sort();

const baseTrees = itemIds.map((item_id: string) => ({
  item_id,
  inputs: [],
  changes: [],
  computations: [],
  result: {},
  notes: [],
}));

const enrichedBase = enrichTreesWithSnapshotAndTotals(baseTrees, snaps, contribRows);
const out = attachContributionToTrees(enrichedBase as any, contribRows as any);

writeJsonOnly(out);

