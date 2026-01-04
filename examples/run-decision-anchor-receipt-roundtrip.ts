// examples/run-decision-anchor-receipt-roundtrip.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { makeAnchorReceipt, verifyAnchorReceipt } from "../packages/decision/src/anchor-receipt.js";

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

  const decision_id = "dec_anchor_receipt_roundtrip_001";
  const snapshotPolicy = { every_n_events: 1 };

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Receipt Roundtrip", owner_id: "system", source: "receipt-roundtrip" },
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

  const anchors = await store.listAnchors();
  const last = anchors[anchors.length - 1];
  if (!last) throw new Error("No anchors found");

  const receipt = makeAnchorReceipt(last);
  const verify = verifyAnchorReceipt(receipt);

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

