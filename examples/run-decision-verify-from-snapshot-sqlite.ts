// examples/run-decision-verify-from-snapshot-sqlite.ts
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifyDecisionFromSnapshot } from "../packages/decision/src/store-verify.js";

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

  const decision_id = "dec_verify_from_snapshot_001";

  // Create + VALIDATE (seq 1)
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Verify From Snapshot Demo", owner_id: "system" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    { now }
  );
  assert(r1.ok, "validate failed");

  // SIMULATE (seq 2)
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
    },
    { now }
  );
  assert(r2.ok, "simulate failed");

  // If your store-engine snapshot policy creates snapshots, this will use it.
  // Otherwise it will just fall back to full-chain verification.
  const result = await verifyDecisionFromSnapshot(store, decision_id, {
    allowMissingHashes: false,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

