// examples/run-diff-explain.ts
import {
  SqliteDecisionStore,
  rewindDecisionWithStore,
} from "../packages/decision/src/index.js";

import { diffDecisions } from "../packages/decision/src/replay";

function parseArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function summarizeDiff(diff: Array<{ path: string; before: any; after: any }>) {
  const state = diff.find((d) => d.path === "state");
  const updated = diff.find((d) => d.path === "updated_at");

  const buckets = {
    state: [] as any[],
    provenance: [] as any[],
    execution: [] as any[],
    trust: [] as any[],
    pls: [] as any[],
    other: [] as any[],
  };

  for (const d of diff) {
    if (d.path === "state" || d.path === "updated_at") buckets.state.push(d);
    else if (d.path.includes("provenance")) buckets.provenance.push(d);
    else if (d.path.includes("execution")) buckets.execution.push(d);
    else if (d.path.includes("trust")) buckets.trust.push(d);
    else if (d.path.includes("pls") || d.path.includes("liability_shield")) buckets.pls.push(d);
    else buckets.other.push(d);
  }

  console.log("=== SUMMARY ===");
  if (state) console.log("state:", state.before, "->", state.after);
  if (updated) console.log("updated_at:", updated.before, "->", updated.after);

  const printBucket = (name: string, arr: any[]) => {
    if (!arr.length) return;
    console.log(`\n[${name}] changes:`, arr.length);
    for (const x of arr.slice(0, 20)) {
      console.log("-", x.path);
    }
    if (arr.length > 20) console.log(`... +${arr.length - 20} more`);
  };

  printBucket("execution", buckets.execution);
  printBucket("pls", buckets.pls);
  printBucket("trust", buckets.trust);
  printBucket("provenance", buckets.provenance);
  printBucket("other", buckets.other);

  console.log("\n=== FULL DIFF ===");
  console.log(JSON.stringify(diff, null, 2));
}

async function main() {
  const dbPath = parseArg("--db") ?? "replay-demo.db";
  const decisionA = parseArg("--a") ?? "dec_exec_001";
  const decisionB = parseArg("--b") ?? "dec_exec_001_branch_approve";
  const uptoStr = parseArg("--upto") ?? "0";
  const upto = Math.max(0, Math.floor(Number(uptoStr)));

  const store = new SqliteDecisionStore(dbPath as any);

  const ra = await rewindDecisionWithStore(store as any, { decision_id: decisionA, up_to_seq: upto }, {});
  const rb = await rewindDecisionWithStore(store as any, { decision_id: decisionB, up_to_seq: upto }, {});

  if (!ra.ok) throw new Error("A rewind failed");
  if (!rb.ok) throw new Error("B rewind failed");

  const diff = diffDecisions(ra.decision as any, rb.decision as any);
  summarizeDiff(diff as any);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

