import Database from "better-sqlite3";
import { ensureEnterpriseTables } from "../packages/decision/src/enterprise-schema.js";
import { applyEventWithStore, persistCounterfactualBranchWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "./run-decision-store-sqlite.js";

async function run() {
  const db = new Database(":memory:");
  const store = new SqliteDecisionStore(db); // ✅ same DB
  ensureEnterpriseTables(db);

  const sourceId = `d_fork_tamper_src_${Date.now()}`;
  const branchId = `d_fork_tamper_branch_${Date.now()}`;

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
  if (!r1.ok) throw new Error(`source apply failed: ${JSON.stringify(r1.violations)}`);

  const fork1 = await persistCounterfactualBranchWithStore(
    store as any,
    {
      decision_id: sourceId,
      new_decision_id: branchId,
      edits: { replace: [], append: [] },
      internal_bypass_enterprise_gates: true,
    } as any,
    {}
  );
  if (!fork1.ok) throw new Error(`fork1 failed: ${JSON.stringify((fork1 as any).violations ?? fork1)}`);

  // ✅ tamper same DB
  db.prepare(`UPDATE fork_receipts SET receipt_hash=? WHERE branch_decision_id=?`).run(
    "0".repeat(64),
    branchId
  );

  const fork2 = await persistCounterfactualBranchWithStore(
    store as any,
    {
      decision_id: sourceId,
      new_decision_id: branchId,
      edits: { replace: [], append: [] },
      internal_bypass_enterprise_gates: true,
    } as any,
    {}
  );

  const violations = (fork2 as any).violations ?? [];
  const hasTamper = violations.some((v: any) => String(v?.code) === "FORK_RECEIPT_TAMPERED");

  if (!hasTamper) {
    console.log("fork2 result:", JSON.stringify(fork2, null, 2));
    throw new Error("Expected FORK_RECEIPT_TAMPERED, but did not see it.");
  }

  console.log("✅ fork receipt tamper detected as expected");
}

run().catch((e) => {
  console.error("❌ fork receipt tamper test failed", e);
  process.exit(1);
});

