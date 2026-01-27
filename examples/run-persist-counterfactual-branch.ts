// examples/run-persist-counterfactual-branch.ts
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import {
  SqliteDecisionStore,
  persistCounterfactualBranchWithStore,
  type CounterfactualEdits,
} from "../packages/decision/src/index.js";

function parseArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function shellQuote(s: string): string {
  // simple, safe-ish quoting for paths/ids
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function main() {
  const dbPath = parseArg("--db") ?? "replay-demo.db";
  const decisionId = parseArg("--decision") ?? "dec_exec_001";
  const newId = parseArg("--new") ?? `${decisionId}_cf_${Date.now()}`;

  const uptoStr = parseArg("--upto");
  const upto =
    uptoStr != null ? Math.max(0, Math.floor(Number(uptoStr))) : undefined;

  const nowArg = parseArg("--now"); // optional deterministic time
  const nowIso = () => (nowArg ? String(nowArg) : new Date().toISOString());

  // default action: append APPROVE unless user asks reject
  const wantReject = hasFlag("--reject");
  const wantApprove = hasFlag("--approve") || !wantReject;

  const verify = !hasFlag("--no-verify"); // default: verify branch by rewinding it
  const verifyUptoStr = parseArg("--verify-upto");
  const verifyUpto =
    verifyUptoStr != null
      ? Math.max(0, Math.floor(Number(verifyUptoStr)))
      : 999999;

  const edits: CounterfactualEdits = {
    append: [
      wantReject
        ? ({ type: "REJECT", actor_id: "counterfactual", actor_type: "human" } as any)
        : ({ type: "APPROVE", actor_id: "counterfactual", actor_type: "human" } as any),
    ],
  };

  // keep DB open for sqlite store + any internal reads
  // (Database object is unused directly but can help ensure file exists / locked early)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _db = new Database(dbPath);

  // SqliteDecisionStore expects a path in your implementation
  const store = new SqliteDecisionStore(dbPath as any);

  const res = await persistCounterfactualBranchWithStore(
    store as any,
    {
      decision_id: decisionId,
      new_decision_id: newId,
      up_to_seq: upto,
      edits,
      internal_bypass_enterprise_gates: true,
      enforce_trust_boundary: false,
      meta: {
        demo: true,
        mode: wantReject ? "REJECT_BRANCH" : "APPROVE_BRANCH",
      },
    },
    { now: nowIso }
  );

  if (!res.ok) {
    console.error("persist ok:", res.ok);
    console.error("branch:", res.branch_decision_id);
    console.error("applied_events:", res.applied_events);
    console.error("violations:", (res as any).violations);
    process.exitCode = 1;
    return;
  }

  console.log("persist ok:", res.ok);
  console.log("source:", res.source_decision_id);
  console.log("branch:", res.branch_decision_id);
  console.log("applied_events:", res.applied_events);

  // IMPORTANT:
  // res.counterfactual.decision reflects the in-memory counterfactual result object,
  // not necessarily what you *persisted* to sqlite / what rewind will compute.
  console.log("counterfactual_state_in_memory:", (res.counterfactual.decision as any).state);

  console.log("used:", res.used);

  // ✅ Verify what was actually persisted by rewinding the NEW branch decision_id.
  if (verify) {
    console.log("\n=== VERIFY (rewind persisted branch) ===");
    try {
      const cmd =
        `npm exec -- tsx examples/run-rewind.ts -- ` +
        `--db ${shellQuote(dbPath)} ` +
        `--decision ${shellQuote(res.branch_decision_id)} ` +
        `--upto ${String(verifyUpto)}`;

      const out = execSync(cmd, { stdio: "pipe", encoding: "utf8" });
      process.stdout.write(out.trimEnd() + "\n");
    } catch (e: any) {
      console.error("verify rewind failed:", e?.message ?? e);
      // keep non-zero so CI catches it
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

