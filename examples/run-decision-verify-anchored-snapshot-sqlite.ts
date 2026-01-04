// examples/run-decision-verify-anchored-snapshot-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifySnapshotIsAnchored } from "../packages/decision/src/store-verify-anchored-snapshot.js";

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

  const decision_id = "dec_anchor_receipt_001";
  const snapshotPolicy = { every_n_events: 1 };

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Anchor Receipt", owner_id: "system", source: "anchor-receipt" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 100 },
    },
    opts
  );

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 100 },
    },
    opts
  );

  const latest = await store.getLatestSnapshot(decision_id);
  if (!latest) throw new Error("No snapshot");

  const res = await verifySnapshotIsAnchored(store, store, {
    decision_id,
    up_to_seq: latest.up_to_seq,
  });

  console.log(res);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

