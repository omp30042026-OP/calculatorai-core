import { readFileSync } from "node:fs";
import {
  parseDecision,
  canonicalizeDecision,
  checkInvariants,
} from "../packages/cds/src/index.js";
import { computeConcentrationRiskV0 } from "../packages/risk/src/concentration.js";

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
  const report = computeConcentrationRiskV0(canon);
  console.log(JSON.stringify(report, null, 2));
}
