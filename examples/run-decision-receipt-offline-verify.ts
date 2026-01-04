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
    t += 5; // deterministic step
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_receipt_offline_001";
  const snapshotPolicy = { every_n_events: 1 };

  // Create event -> snapshot -> anchor
  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Receipt Offline", owner_id: "system", source: "receipt-offline" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "v1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 10 },
    },
    opts
  );

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "s1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 10 },
    },
    opts
  );

  const snap = await store.getLatestSnapshot(decision_id);
  if (!snap) throw new Error("no snapshot");

  // ✅ Call in a way that matches the public overloads:
  // exportDecisionReceiptV1(store, "decision_id", snapshot_up_to_seq)
  const receipt = await exportDecisionReceiptV1(store, decision_id, snap.up_to_seq);
  if (!receipt) throw new Error("no receipt");

  // simulate offline: no DB access needed from here
  const verify = verifyReceiptOffline(receipt);

  console.log({
    ok: verify.ok,
    verify,
    receipt,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

