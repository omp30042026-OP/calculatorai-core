import { readFileSync } from "node:fs";
import { buildDecisionSnapshots } from "../packages/simulate/src/snapshot";
import { computeMarginImpactFromSnapshots } from "../packages/compute/src/margins";

// Tiny helper
function loadJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function fail(msg: string): never {
  console.error("❌", msg);
  process.exit(1);
}

const decisionPath = process.argv[2] ?? "examples/decisions/multi-item.json";
const decision = loadJson(decisionPath);

const snaps = buildDecisionSnapshots(decision);
const rows: any[] = computeMarginImpactFromSnapshots(snaps);

if (!Array.isArray(rows) || rows.length === 0) fail("No contrib rows returned");

for (const r of rows) {
  if (!r?.item_id) fail(`Row missing item_id: ${JSON.stringify(r)}`);

  // These should exist if decomposition is working
  const required = [
    "bp",
    "bc",
    "bv",
    "sp",
    "sc",
    "sv",
    "baseline_total_margin",
    "simulated_total_margin",
    "delta_total_margin",
    "price_effect",
    "cost_effect",
    "volume_effect",
  ];

  for (const k of required) {
    if (r[k] == null) {
      fail(`Missing ${k} for ${r.item_id}. Got keys: ${Object.keys(r).join(", ")}`);
    }
  }

  // sanity: effects should sum (with interaction) close to delta if you have interaction_effect
  if (r.interaction_effect != null) {
    const sum =
      Number(r.price_effect) + Number(r.cost_effect) + Number(r.volume_effect) + Number(r.interaction_effect);
    const delta = Number(r.delta_total_margin);
    const err = Math.abs(sum - delta);
    if (!Number.isFinite(err) || err > 1e-6) {
      fail(`Effect sum mismatch for ${r.item_id}: sum=${sum} delta=${delta} err=${err}`);
    }
  }
}

console.log("✅ assert-effects ok:", decisionPath);
