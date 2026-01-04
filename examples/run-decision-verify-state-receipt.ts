// examples/run-decision-verify-state-receipt.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { exportAnchorReceiptV2 } from "../packages/decision/src/store-export-anchor-receipt.js";
import { verifyDecisionStateAgainstReceipt } from "../packages/decision/src/state-receipt-verify.js";
import { verifyReceiptOffline } from "../packages/decision/src/receipt-verify.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 5;
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_state_receipt_001";
  const snapshotPolicy = { every_n_events: 1 };

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "State Receipt", owner_id: "system", source: "state-receipt" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "v1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 50 },
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
      anchorRetentionPolicy: { keep_last_n_anchors: 50 },
    },
    opts
  );

  const snap = await store.getLatestSnapshot(decision_id);
  if (!snap) throw new Error("no snapshot");

  const receipt = await exportAnchorReceiptV2(store, decision_id, snap.up_to_seq);
  if (!receipt) throw new Error("no receipt");

  // (A) Your existing offline receipt verify (anchor integrity, pinned head rules, etc.)
  const offline = verifyReceiptOffline(receipt as any);

  // (B) Feature 32: verify the *decision JSON state* matches receipt.state_hash
  const state = verifyDecisionStateAgainstReceipt(receipt as any, (snap as any).decision);

  console.log({
    ok: offline.ok && state.ok,
    offline,
    state,
    receipt,
    snapshot_up_to_seq: snap.up_to_seq,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

