// examples/run-decision-receipt-offline-verify.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { exportDecisionReceiptV1 } from "../packages/decision/src/store-export-anchor-receipt.js";
import { verifyReceiptOffline } from "../packages/decision/src/receipt-verify.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 5;
    return iso;
  };
}

async function ensureSnapshotAndAnchor(store: SqliteDecisionStore, decision_id: string, now: () => string) {
  let snap = await store.getLatestSnapshot(decision_id);
  if (snap) return snap;

  // ✅ manually create snapshot at current head
  const last = await store.getLastEvent(decision_id);
  if (!last) throw new Error("no events; cannot create snapshot");

  const decision = await store.getDecision(decision_id);
  if (!decision) throw new Error("missing decision; cannot create snapshot");

  await store.putSnapshot({
    decision_id,
    up_to_seq: last.seq,
    decision,
    created_at: now(),
    // checkpoint_hash/root_hash can be omitted; SqliteDecisionStore.putSnapshot will compute them
  } as any);

  snap = await store.getLatestSnapshot(decision_id);
  if (!snap) throw new Error("snapshot still missing after manual putSnapshot");

  // ✅ ensure there is an anchor for this snapshot (receipt export depends on anchors)
  await store.appendAnchor({
    at: now(),
    decision_id,
    snapshot_up_to_seq: snap.up_to_seq,
    checkpoint_hash: (snap as any).checkpoint_hash ?? null,
    root_hash: (snap as any).root_hash ?? null,
    // state_hash is optional; include only if your schema + AppendAnchorInput supports it
    // state_hash: (snap as any).state_hash ?? null,
  } as any);

  return snap;
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_receipt_offline_001";
  const snapshotPolicy = { every_n_events: 1 };

  const anchorPolicy = { enabled: true };
  const anchorRetentionPolicy = { keep_last_n_anchors: 10 };

  // 1) VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Receipt Offline", owner_id: "system", source: "receipt-offline" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "v1",

      snapshotStore: store,
      snapshotPolicy,

      anchorStore: store,
      anchorPolicy,
      anchorRetentionPolicy,
    },
    opts
  );
  if (!r1.ok) throw new Error("validate blocked");

  // 2) SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "s1",

      snapshotStore: store,
      snapshotPolicy,

      anchorStore: store,
      anchorPolicy,
      anchorRetentionPolicy,
    },
    opts
  );
  if (!r2.ok) throw new Error("simulate blocked");

  // 3) extra event
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        artifacts: { extra: { tick: 0 } },
      },
      idempotency_key: "tick-0",

      snapshotStore: store,
      snapshotPolicy,

      anchorStore: store,
      anchorPolicy,
      anchorRetentionPolicy,
    },
    opts
  );
  if (!r3.ok) throw new Error("tick blocked");

  // ✅ guarantee snapshot exists (even if snapshot policy didn’t fire)
  const snap = await ensureSnapshotAndAnchor(store, decision_id, now);

  const receipt = await exportDecisionReceiptV1({
    anchorStore: store,
    decision_id,
    snapshot_up_to_seq: snap.up_to_seq,
  });

  if (!receipt) throw new Error("no receipt");

  const decision = await store.getDecision(decision_id);

  const verify = verifyReceiptOffline(receipt, { decision });
  console.log({ ok: verify.ok, verify, receipt });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

