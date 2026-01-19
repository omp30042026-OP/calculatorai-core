// examples/run-decision-immutability-window.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

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

  const decision_id = "dec_immutable_001";

  // NOTE:
  // Your DecisionEvent union does NOT include "ADD_NOTE",
  // so do NOT put it in allow_event_types.
  const immutabilityPolicy = {
    enabled: true,
    locked_states: ["APPROVED", "REJECTED"],
    lock_after_seconds: 0, // immediate lock after APPROVE/REJECT
    allow_event_types: ["ATTACH_ARTIFACTS"],
  };

  const validate = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: {
        title: "Immutability Demo",
        owner_id: "system",
        source: "demo",
      },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
      immutabilityPolicy,
    },
    opts
  );

  const approve = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "alice" } as any,
      idempotency_key: "a1",
      immutabilityPolicy,
    },
    opts
  );

  // should BLOCK (because APPROVED is locked + event not allowlisted)
  const mutate_after_lock = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v2",
      immutabilityPolicy,
    },
    opts
  );

  // should PASS (allowlisted evidence event)
  const attach_after_lock = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "alice",
        artifacts: {
          evidence: { kind: "link", url: "https://example.com/audit-proof" },
        },
      } as any,
      idempotency_key: "attach1",
      immutabilityPolicy,
    },
    opts
  );

  process.stdout.write(
    JSON.stringify(
      { validate, approve, mutate_after_lock, attach_after_lock },
      null,
      2
    ) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});









