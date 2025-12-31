// examples/run-decision-audit-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { getAuditView } from "../packages/decision/src/store-audit.js";

// assert
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_audit_sqlite_001";

  // seq1 VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Audit Demo", owner_id: "system", source: "audit-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 2 },
      snapshotRetentionPolicy: {
        keep_last_n_snapshots: 2,
        prune_events_up_to_latest_snapshot: true,
      },
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq2 SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 2 },
      snapshotRetentionPolicy: {
        keep_last_n_snapshots: 2,
        prune_events_up_to_latest_snapshot: true,
      },
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  // seq3 attach
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        artifacts: { explain_tree_id: "tree_audit_001", extra: { note: "audit demo" } },
      },
      idempotency_key: "attach-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 2 },
      snapshotRetentionPolicy: {
        keep_last_n_snapshots: 2,
        prune_events_up_to_latest_snapshot: true,
      },
    },
    opts
  );
  assert(r3.ok, "attach failed");

  // Audit view + diff (seq1 -> seq3)
  const out = await getAuditView(
    store,
    {
      decision_id,
      recent_events_limit: 10,
      snapStore: store,
      diff_from_seq: 1,
      diff_to_seq: 3,
    },
    opts
  );
  assert(out.ok, "audit failed");

  console.log(JSON.stringify(out.view, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



