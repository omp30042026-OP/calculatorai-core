// examples/run-decision-verify-inclusion-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifyEventIncludedFromLatestSnapshot } from "../packages/decision/src/store-verify-inclusion.js";

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

  const decision_id = "dec_merkle_inclusion_001";

  // Force snapshot every event (so root_hash is always present quickly)
  const snapshotPolicy = { every_n_events: 1 };

  // seq=1
  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Merkle Inclusion", owner_id: "system", source: "feature-23" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );

  // seq=2
  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
      snapshotStore: store,
      snapshotPolicy,
    },
    opts
  );

  // prove inclusion of seq=2 in the latest snapshot root
  const result = await verifyEventIncludedFromLatestSnapshot(store, decision_id, 2);
  console.log(result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

