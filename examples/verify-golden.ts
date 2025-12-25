import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function norm(s: string) {
  // normalize whitespace only, keep content stable
  return s.trim().replace(/\r\n/g, "\n");
}

const expected = norm(readFileSync("examples/golden/margin-tree.expected.json", "utf-8"));
const actual = norm(execSync("npx tsx examples/run-explain-tree.ts", { encoding: "utf-8" }));

if (expected !== actual) {
  console.error("GOLDEN TEST FAILED: explain tree output changed.");
  process.exitCode = 1;
} else {
  console.log("Golden test passed.");
}
