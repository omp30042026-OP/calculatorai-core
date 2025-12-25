import { readFileSync } from "node:fs";
import {
  parseDecision,
  canonicalizeDecision,
  checkInvariants,
} from "../packages/cds/src/index.js";
import { buildDecisionSnapshots } from "../packages/simulate/src/snapshot.js";
import { computeContributionFromSnapshots } from "../packages/compute/src/contribution.js";

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
  const rows = computeContributionFromSnapshots(snaps);
  console.log(JSON.stringify(rows, null, 2));
}
