import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Case = { name: string; runner: string; expected: string };

const cases: Case[] = [
  { name: "single", runner: "examples/run-explain-tree.ts", expected: "examples/golden/margin-tree.expected.json" },
  { name: "multi", runner: "examples/run-explain-multi.ts", expected: "examples/golden/margin-tree.multi.expected.json" },
];

function runTsx(file: string): string {
  const res = spawnSync("npx", ["tsx", file], { encoding: "utf-8" });
  if (res.status !== 0) {
    console.error(res.stdout);
    console.error(res.stderr);
    process.exit(res.status ?? 1);
  }
  return res.stdout;
}

const norm = (s: string) => JSON.stringify(JSON.parse(s), null, 2) + "\n";

let ok = true;

for (const c of cases) {
  const actual = norm(runTsx(c.runner));
  const expected = norm(readFileSync(c.expected, "utf-8"));

  if (actual !== expected) {
    ok = false;
    console.error(`❌ Golden mismatch: ${c.name}`);
    console.error(`   runner: ${c.runner}`);
    console.error(`   expected: ${c.expected}`);
  } else {
    console.log(`✅ Golden ok: ${c.name}`);
  }
}

if (!ok) process.exit(1);
console.log("Golden test passed.");
