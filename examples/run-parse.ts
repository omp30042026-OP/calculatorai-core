import { readFileSync } from "node:fs";
import { parseDecision, canonicalizeDecision } from "../packages/cds/src/index.js";

const raw = JSON.parse(
  readFileSync("examples/decisions/price-change.json", "utf-8")
);

const parsed = parseDecision(raw);
const canon = canonicalizeDecision(parsed);

console.log(JSON.stringify(canon, null, 2));
