import { readFileSync } from "node:fs";
import {
  parseDecision,
  canonicalizeDecision,
  checkInvariants,
} from "../packages/cds/src/index.js";
import { buildDecisionSnapshots } from "../packages/simulate/src/snapshot.js";
import {
  computeConcentrationRiskBaselineV1,
  computeConcentrationRiskSimulatedV1,
  computeConcentrationDeltaV1,
} from "../packages/risk/src/concentration-v1.js";

const raw = JSON.parse(
  readFileSync("examples/decisions/price-change.json", "utf-8")
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

  const base = computeConcentrationRiskBaselineV1(canon);
  const sim = computeConcentrationRiskSimulatedV1(canon, snaps);
  const delta = computeConcentrationDeltaV1(base, sim);

  console.log(
    JSON.stringify(
      { baseline: base, simulated: sim, delta },
      null,
      2
    )
  );
}
