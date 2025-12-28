// examples/run-decision-snapshots-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

// ---- tiny assert helper ----
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---- deterministic now() for replay ----
function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1; // +1ms each call
    return iso;
  };
}

async function main() {
  // ✅ MUST be clean per run
  const store = new SqliteDecisionStore(":memory:");

  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_snap_sqlite_001";
  const snapshotPolicy = { every_n_events: 3 };

  // ✅ NEW: retention / pruning policy
  const snapshotRetentionPolicy = {
    keep_last_n_snapshots: 2,
    prune_events_up_to_latest_snapshot: true,
  };

  // 1) VALIDATE ONCE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: {
        title: "SQLite Snapshot Demo",
        owner_id: "system",
        source: "sqlite-snapshots-demo",
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",

      snapshotStore: store,
      snapshotPolicy,
      snapshotRetentionPolicy,
    },
    opts
  );
  if (!r1.ok) console.error("VALIDATE blocked:", r1.violations);
  assert(r1.ok, "validate failed");

  // 2) SIMULATE (valid after VALIDATED)
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",

      snapshotStore: store,
      snapshotPolicy,
      snapshotRetentionPolicy,
    },
    opts
  );
  if (!r2.ok) console.error("SIMULATE blocked:", r2.violations);
  assert(r2.ok, "simulate failed");

  // 3) Add no-op events to trigger snapshots
  for (let i = 0; i < 10; i++) {
    const r = await applyEventWithStore(
      store,
      {
        decision_id,
        event: {
          type: "ATTACH_ARTIFACTS",
          actor_id: "system",
          artifacts: {
            extra: { tick: i }, // ✅ extra is Record<string, unknown>
          },
        },
        idempotency_key: `tick-${i}`,

        snapshotStore: store,
        snapshotPolicy,
        snapshotRetentionPolicy,
      },
      opts
    );
    if (!r.ok) console.error(`TICK ${i} blocked:`, r.violations);
    assert(r.ok, `tick ${i} failed`);
  }

  const snap = await store.getLatestSnapshot(decision_id);
  assert(snap, "missing snapshot");
  assert(snap.up_to_seq >= 3, "snapshot did not advance (expected >= 3)");

  const current = await store.getDecision(decision_id);
  assert(current, "missing current decision");

  console.log(
    JSON.stringify(
      {
        decision_id,
        state: current.state,
        current_version: current.version,
        snapshot_up_to_seq: snap.up_to_seq,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

