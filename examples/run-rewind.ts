// examples/run-rewind.ts
import { SqliteDecisionStore, rewindDecisionWithStore } from "../packages/decision/src/index.js";

function parseArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const dbPath = parseArg("--db") ?? "replay-demo.db";
  const decisionId = parseArg("--decision") ?? "dec_exec_001";
  const uptoStr = parseArg("--upto") ?? "0";
  const upto = Math.max(0, Math.floor(Number(uptoStr)));

  // ✅ IMPORTANT: SqliteDecisionStore wants a filepath (string), not a Database instance
  const store = new SqliteDecisionStore(dbPath as any);

  const res = await rewindDecisionWithStore(store as any, {
    decision_id: decisionId,
    up_to_seq: upto,
  });

  if (!res.ok) {
    console.error("rewind ok:", res.ok);
    console.error("up_to_seq:", res.up_to_seq, "base_seq:", res.base_seq);
    console.error("violations:", res.violations);
    process.exitCode = 1;
    return;
  }

  console.log("rewind ok:", res.ok);
  console.log("up_to_seq:", res.up_to_seq, "base_seq:", res.base_seq);
  console.log("state:", (res.decision as any).state);
  console.log("updated_at:", (res.decision as any).updated_at);
  console.log("warnings:", res.warnings ?? []);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});