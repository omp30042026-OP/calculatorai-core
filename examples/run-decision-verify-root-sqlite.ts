// examples/run-decision-verify-root-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifyDecisionRootFromSnapshot } from "../packages/decision/src/store-verify-root.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_root_verify_001";

  // Force snapshot each event
  const snapshotPolicy = { every_n_events: 1 };

  // 1) VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Root Verify", owner_id: "system", source: "root-verify" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );
  if (!r1.ok) throw new Error("validate failed");

  // 2) SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );
  if (!r2.ok) throw new Error("simulate failed");

  const result = await verifyDecisionRootFromSnapshot(store, decision_id, store);

  if (!result.ok) {
    console.log({
      ok: false,
      decision_id,
      code: result.code,
      message: result.message,
      snapshot_up_to_seq: result.snapshot_up_to_seq ?? null,
      snapshot_root_hash: result.snapshot_root_hash ?? null,
      computed_root_hash: result.computed_root_hash ?? null,
      missing_seq: (result as any).missing_seq ?? null,
    });
    return;
  }

  console.log({
    decision_id: result.decision_id,
    snapshot_up_to_seq: result.snapshot_up_to_seq,
    snapshot_root_hash: result.snapshot_root_hash,
    computed_root_hash: result.computed_root_hash,
    ok: true,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

