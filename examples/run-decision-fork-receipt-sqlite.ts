import Database from "better-sqlite3";
import { ensureEnterpriseTables } from "../packages/decision/src/enterprise-schema.js";
import { applyEventWithStore, persistCounterfactualBranchWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "./run-decision-store-sqlite.js";

async function run() {
  const db = new Database(":memory:");
  const store = new SqliteDecisionStore(db); // ✅ same DB
  ensureEnterpriseTables(db); // ✅ create fork_receipts in the SAME DB

  const sourceId = `d_fork_src_${Date.now()}`;
  const branchId = `d_fork_branch_${Date.now()}`;

  const r1 = await applyEventWithStore(
    store as any,
    {
      decision_id: sourceId,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "seed",
        actor_type: "system",
        artifacts: { extra: { note: "baseline" } },
      } as any,
      internal_bypass_enterprise_gates: true,
    },
    {}
  );
  if (!r1.ok) throw new Error(JSON.stringify(r1.violations));

  const fork = await persistCounterfactualBranchWithStore(
    store as any,
    {
      decision_id: sourceId,
      new_decision_id: branchId,
      edits: { replace: [], append: [] },
      internal_bypass_enterprise_gates: true,
    } as any,
    {}
  );

  if (!fork.ok) throw new Error(`fork failed: ${JSON.stringify((fork as any).violations ?? fork)}`);

  const row = db.prepare(
    `SELECT receipt_hash FROM fork_receipts WHERE branch_decision_id=? LIMIT 1`
  ).get(branchId) as any;

  if (!row) throw new Error("fork_receipts row missing");

  console.log("✅ fork receipts sqlite ok");
}

run().catch((e) => {
  console.error("❌ fork receipt sqlite failed", e);
  process.exit(1);
});

