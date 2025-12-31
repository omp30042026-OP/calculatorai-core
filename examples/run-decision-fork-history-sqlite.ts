// examples/run-decision-fork-history-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { forkDecisionAtSeq } from "../packages/decision/src/store-forks.js";

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

  const original_id = "dec_fork_src_001";

  // seq 1: VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id: original_id,
      metaIfCreate: { title: "Fork Source", owner_id: "system", source: "fork-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq 2: SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id: original_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "simulate-1",
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  // Fork at seq=1 (VALIDATED state)
  const fork_id = "dec_fork_child_001";
  await forkDecisionAtSeq(
    store,
    {
      from_decision_id: original_id,
      targetSeq: 1,
      new_decision_id: fork_id,
      metaIfCreate: { title: "Fork Child", owner_id: "system", source: "fork-demo" },
    },
    opts
  );

  // On the fork, SIMULATE should be valid (because forked at VALIDATED)
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id: fork_id,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "fork-simulate-1",
    },
    opts
  );
  assert(r3.ok, "fork simulate failed");

  const src = await store.getDecision(original_id);
  const child = await store.getDecision(fork_id);
  assert(src && child, "missing decisions");

  console.log(
    JSON.stringify(
      {
        original: { decision_id: src.decision_id, state: src.state, version: src.version },
        fork: { decision_id: child.decision_id, state: child.state, version: child.version, meta: child.meta },
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

