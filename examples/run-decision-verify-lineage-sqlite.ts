// examples/run-decision-verify-lineage-sqlite.ts
import { createDecisionV2 } from "../packages/decision/src/decision.js";
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifyDecisionHashChain } from "../packages/decision/src/store-verify.js";
import { verifyForkLineage } from "../packages/decision/src/store-verify-lineage.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const parent_id = "dec_parent_001";
  const child_id = "dec_child_001";

  // --- parent events ---
  const p1 = await applyEventWithStore(
    store,
    {
      decision_id: parent_id,
      metaIfCreate: { title: "Parent", owner_id: "system", source: "lineage-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "p-validate-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 1 },
    },
    opts
  );
  assert(p1.ok, "parent validate failed");

  const p2 = await applyEventWithStore(
    store,
    {
      decision_id: parent_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "p-sim-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 1 },
    },
    opts
  );
  assert(p2.ok, "parent simulate failed");

  // derive parent checkpoint (last hash)
  const parentChain = await verifyDecisionHashChain(store, parent_id);
  assert(parentChain.ok, "parent chain verify failed");
  assert(parentChain.last_hash, "parent last_hash missing");
  assert(parentChain.last_seq, "parent last_seq missing");

  // --- create child fork decision (store fork checkpoint in meta) ---
  const child = createDecisionV2(
    {
      decision_id: child_id,
      parent_decision_id: parent_id as any, // if your type already supports it, remove "as any"
      meta: {
        title: "Child (Fork)",
        owner_id: "system",
        source: "lineage-demo",
        fork_checkpoint_hash: parentChain.last_hash,
        fork_parent_seq: parentChain.last_seq,
      },
    } as any,
    opts.now
  );

  await store.createDecision(child);
  await store.putDecision(child);

  // --- child events ---
  const c1 = await applyEventWithStore(
    store,
    {
      decision_id: child_id,
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "c-validate-1",
      snapshotStore: store,
      snapshotPolicy: { every_n_events: 1 },
    },
    opts
  );
  assert(c1.ok, "child validate failed");

  // --- verify fork lineage ---
  const res = await verifyForkLineage(store, child_id, {
    parent_fork_seq: parentChain.last_seq,
  });

  console.log(JSON.stringify(res, null, 2));
  assert(res.ok, "verifyForkLineage failed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

