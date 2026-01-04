// examples/run-decision-anchor-receipt-against-head.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

import { exportAnchorReceiptV2 } from "../packages/decision/src/store-export-anchor-receipt.js";
import { verifyReceiptSelf, verifyReceiptNotAfterHead } from "../packages/decision/src/anchor-receipt-v2.js";
import { verifyGlobalAnchorChain } from "../packages/decision/src/store-verify-anchors.js";

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

  const decision_id = "dec_anchor_receipt_head_001";
  const snapshotPolicy = { every_n_events: 1 };

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Receipt vs Head", owner_id: "system", source: "receipt-head" },
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

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "system" },
      idempotency_key: "approve-1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy: { keep_last_n_anchors: 100 },
    },
    opts
  );

  // Verify chain first (optional but nice)
  const chainVerify = await verifyGlobalAnchorChain(store);

  // Export receipt for anchor seq=2 and include pinned head
  const receipt = await exportAnchorReceiptV2(store, 2);
  if (!receipt) throw new Error("No receipt exported");

  const self = verifyReceiptSelf(receipt);
  const antiRollback = verifyReceiptNotAfterHead(receipt);

  console.log({
    ok: chainVerify.ok && self.ok && antiRollback.ok,
    chainVerify,
    self,
    antiRollback,
    receipt,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});





