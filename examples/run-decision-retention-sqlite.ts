// examples/run-decision-retention-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

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

  const decision_id = "dec_retention_sqlite_001";
  const snapshotPolicy = { every_n_events: 3 };

  // VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Retention Demo", owner_id: "system", source: "retention-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  // Many events -> many snapshots
  for (let i = 0; i < 20; i++) {
    const r = await applyEventWithStore(
      store,
      {
        decision_id,
        event: {
          type: "ATTACH_ARTIFACTS",
          actor_id: "system",
          artifacts: { extra: { tick: i } },
        },
        snapshotStore: store,
        snapshotPolicy,
      },
      opts
    );
    assert(r.ok, `tick ${i} failed`);
  }

  const beforeEvents = await store.listEvents(decision_id);
  const latest = await store.getLatestSnapshot(decision_id);
  assert(latest, "missing latest snapshot");

  // Keep only last 2 snapshots
  const pr1 = await store.pruneSnapshots(decision_id, 2);

  // After pruning snapshots, prune events up to latest snapshot (safe: replay starts from snapshot)
  const pr2 = await store.pruneEventsUpToSeq(decision_id, latest.up_to_seq);

  const afterEvents = await store.listEvents(decision_id);
  const stillLatest = await store.getLatestSnapshot(decision_id);
  assert(stillLatest, "missing snapshot after prune");

  // Must still be consistent / readable
  const current = await store.getDecision(decision_id);
  assert(current, "missing current decision after prune");

  // Basic sanity: we deleted something
  assert(pr1.deleted >= 0, "pruneSnapshots returned invalid");
  assert(pr2.deleted >= 1, "expected to prune at least 1 event");

  console.log(
    JSON.stringify(
      {
        decision_id,
        latest_snapshot_up_to_seq: stillLatest.up_to_seq,
        events_before: beforeEvents.length,
        events_after: afterEvents.length,
        snapshots_deleted: pr1.deleted,
        events_deleted: pr2.deleted,
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

