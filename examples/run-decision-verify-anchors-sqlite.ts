// examples/run-decision-verify-anchors-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import * as verifyAnchorsMod from "../packages/decision/src/store-verify-anchors.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

function resolveVerifyAnchorsFn(mod: any): (store: any, ...args: any[]) => any {
  return (
    mod.verifyGlobalAnchorChain ??   // ✅ your actual export
    mod.verifyAnchors ??
    mod.verifyAnchorChain ??
    mod.verifyDecisionAnchors ??
    mod.verifyAnchorsChain ??
    mod.default
  );
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_anchors_retention_001";

  // snapshot every event -> will attempt to anchor every event
  const snapshotPolicy = { every_n_events: 1 };

  // ✅ Feature 26 retention: keep only last 2 anchors globally
  const anchorRetentionPolicy = { keep_last_n_anchors: 2 };

  // 1) create a few events => snapshots => anchors
  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Anchors Retention", owner_id: "system", source: "anchors-verify" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy: { enabled: true },
      anchorRetentionPolicy,
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
      anchorRetentionPolicy,
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
      anchorRetentionPolicy,
    },
    opts
  );

  // 2) replay SAME event with SAME idempotency key:
  // should NOT create a new event, and should NOT create a duplicate anchor
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
      anchorRetentionPolicy,
    },
    opts
  );

  // 3) verify anchors
  const verifyFn = resolveVerifyAnchorsFn(verifyAnchorsMod as any);
  if (typeof verifyFn !== "function") {
    throw new Error(
      `No verify fn found in store-verify-anchors exports. Keys: ${Object.keys(verifyAnchorsMod).join(", ")}`
    );
  }

  const verify = await verifyFn(store);
  const anchors = await store.listAnchors();

  // 4) check duplicates by (decision_id, snapshot_up_to_seq)
  const keyCounts = new Map<string, number>();
  for (const a of anchors) {
    const k = `${a.decision_id}@${a.snapshot_up_to_seq}`;
    keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }
  const duplicates = [...keyCounts.entries()].filter(([, c]) => c > 1);

  console.log({
    ok: verify.ok && anchors.length <= 2 && duplicates.length === 0,
    anchors_len: anchors.length,
    duplicates,
    verify,
    anchors,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

