import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";

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

  const decision_id = "dec_snapshot_checkpoint_001";

  // Make snapshots frequently so we always get one quickly
  const snapshotPolicy = { every_n_events: 1 };

  // seq 1
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Checkpoint Demo", owner_id: "system" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotPolicy,
      snapshotStore: store,
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq 2
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
      snapshotPolicy,
      snapshotStore: store,
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  const latestSnap = await store.getLatestSnapshot(decision_id);
  assert(latestSnap, "expected latest snapshot");

  // Check: checkpoint_hash should equal the event hash at up_to_seq
  const events = await store.listEvents(decision_id);
  const lastIncluded = events.find((e) => e.seq === latestSnap.up_to_seq);
  assert(lastIncluded, "expected event at snapshot up_to_seq");

  assert(
    (latestSnap.checkpoint_hash ?? null) === (lastIncluded.hash ?? null),
    `checkpoint_hash mismatch: snap=${latestSnap.checkpoint_hash} event=${lastIncluded.hash}`
  );

  console.log(
    JSON.stringify(
      {
        decision_id,
        snapshot_up_to_seq: latestSnap.up_to_seq,
        snapshot_checkpoint_hash: latestSnap.checkpoint_hash,
        event_hash_at_up_to_seq: lastIncluded.hash,
        ok: true,
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

