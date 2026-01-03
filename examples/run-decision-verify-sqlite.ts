// examples/run-decision-verify-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { verifyDecisionHashChain } from "../packages/decision/src/store-verify.js";

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
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_verify_sqlite_001";

  // Create + VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Verify Demo", owner_id: "system", source: "verify-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  const v = await verifyDecisionHashChain(store, decision_id);
  assert(v.ok, `verify failed: ${JSON.stringify(v, null, 2)}`);

  console.log(
    JSON.stringify(
      {
        decision_id,
        verified_count: v.verified_count,
        last_seq: v.last_seq,
        last_hash: v.last_hash,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

