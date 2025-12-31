// examples/run-decision-observability-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

import { getDecisionObservability } from "../packages/decision/src/store-observability.js";

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

  // Demo ids
  const rootId = "dec_obs_root_001";
  const forkA = "dec_obs_forkA_001";

  // root
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id: rootId,
      metaIfCreate: { title: "Obs Root", owner_id: "system", source: "obs-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "root-validate-1",
    },
    opts
  );
  assert(r1.ok, "root validate failed");

  const r2 = await applyEventWithStore(
    store,
    {
      decision_id: rootId,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "root-simulate-1",
    },
    opts
  );
  assert(r2.ok, "root simulate failed");

  // forkA
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id: forkA,
      metaIfCreate: {
        title: "Obs Fork A",
        owner_id: "system",
        source: "obs-demo",
        parent_decision_id: rootId,
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "forkA-validate-1",
    },
    opts
  );
  assert(r3.ok, "forkA validate failed");

  // ---- one call ----
  const out = await getDecisionObservability(
    store,
    {
      decision_id: rootId,
      recent_events_limit: 25,

      // lineage (optional)
      root_decision_id: rootId,
      candidate_decision_ids: [rootId, forkA],

      // if you have a dedicated snapshot store instance, pass it here:
      // snapStore: snapshotStore,
    },
    opts
  );
  assert(out.ok, "observability failed");

  console.log(JSON.stringify(out.bundle, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

