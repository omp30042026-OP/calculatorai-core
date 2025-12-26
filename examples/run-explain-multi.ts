import { readFileSync } from "node:fs";
import {
  parseDecision,
  canonicalizeDecision,
  checkInvariants,
} from "../packages/cds/src/index.js";
import { buildDecisionSnapshots } from "../packages/simulate/src/snapshot.js";
import { computeMarginImpactFromSnapshots } from "../packages/compute/src/margins.js";
import { computeContributionFromSnapshots } from "../packages/compute/src/contribution.js";
import { buildMarginExplainTrees } from "../packages/explain/src/explain-margin-tree.js";
import { attachContributionToTrees } from "../packages/explain/src/explain-contribution-tree.js";
import { computeConcentrationRiskV0 } from "../packages/risk/src/concentration.js";
import { attachConcentrationRiskToTrees } from "../packages/explain/src/explain-risk-tree.js";
import {
  computeConcentrationRiskBaselineV1,
  computeConcentrationRiskSimulatedV1,
  computeConcentrationDeltaV1,
} from "../packages/risk/src/concentration-v1.js";
import { attachConcentrationDeltaToTrees } from "../packages/explain/src/explain-risk-delta-tree.js";
import { attachSkippedChangesToTrees } from "../packages/explain/src/explain-skipped-changes-tree.js";

const raw = JSON.parse(
  readFileSync("examples/decisions/multi-item.json", "utf-8")
);

const parsed = parseDecision(raw);
const canon = canonicalizeDecision(parsed);
const violations = checkInvariants(canon);

if (violations.length) {
  console.error("Invariant violations:");
  for (const v of violations) console.error(`- ${v.code} ${v.path}: ${v.message}`);
  process.exitCode = 1;
} else {
  const snaps = buildDecisionSnapshots(canon);

  // Optional debug
  console.log("SNAPS keys:", Object.keys(snaps));
  console.log(
    "SNAPSHOT item_ids:",
    Array.from(
      new Set([
        ...(snaps.baseline ?? []).map((r: any) => r.item_id),
        ...(snaps.simulated ?? []).map((r: any) => r.item_id),
      ])
    ).sort()
  );

  const marginRows = computeMarginImpactFromSnapshots(snaps);
  let trees = buildMarginExplainTrees(canon, snaps, marginRows);

  // ✅ IMPORTANT: attach time_gating/override/skips first, so contribution can read meta
  trees = attachSkippedChangesToTrees(canon, snaps, trees);

  const contrib = computeContributionFromSnapshots(snaps);
  trees = attachContributionToTrees(trees, contrib);

  const riskV0 = computeConcentrationRiskV0(canon);
  trees = attachConcentrationRiskToTrees(trees, riskV0);

  const baseV1 = computeConcentrationRiskBaselineV1(canon);
  const simV1 = computeConcentrationRiskSimulatedV1(canon, snaps);
  const deltaV1 = computeConcentrationDeltaV1(baseV1, simV1);
  trees = attachConcentrationDeltaToTrees(trees, deltaV1);

  console.log(JSON.stringify(trees, null, 2));
}

