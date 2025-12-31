// examples/run-decision-fork-graph-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { buildForkGraph } from "../packages/decision/src/store-fork-graph.js";

// ---- assert helper ----
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---- deterministic clock ----
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

  const rootId = "dec_forkgraph_root_001";
  const forkA = "dec_forkgraph_forkA_001";
  const forkB = "dec_forkgraph_forkB_001";

  // ---- root ----
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id: rootId,
      metaIfCreate: {
        title: "Fork Graph Root",
        owner_id: "system",
        source: "fork-graph-demo",
        // optional (but fine)
        parent_decision_id: null,
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "root-validate-1",
    },
    opts
  );
  if (!r1.ok) console.error("ROOT VALIDATE blocked:", r1.violations);
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
  if (!r2.ok) console.error("ROOT SIMULATE blocked:", r2.violations);
  assert(r2.ok, "root simulate failed");

  // ---- fork A ----
  // IMPORTANT: include the same required meta keys + parent_decision_id
  const r3 = await applyEventWithStore(
  store,
  {
    decision_id: forkA,
    metaIfCreate: {
      title: "Fork A",
      owner_id: "system",
      source: "fork-graph-demo",
      parent_decision_id: rootId,
      fork_from_seq: 2, // ✅ REQUIRED
    },
    event: { type: "VALIDATE", actor_id: "system" },
    idempotency_key: "forkA-validate-1",
  },
  opts
);
assert(r3.ok, "fork a failed");

  // optional: simulate fork A (keeps it consistent with other demos)
  const r4 = await applyEventWithStore(
    store,
    {
      decision_id: forkA,
      event: { type: "SIMULATE", actor_id: "system" },
      idempotency_key: "forkA-simulate-1",
    },
    opts
  );
  if (!r4.ok) console.error("FORK A SIMULATE blocked:", r4.violations);
  assert(r4.ok, "fork a simulate failed");

  // ---- fork B ----
  const r5 = await applyEventWithStore(
    store,
    {
      decision_id: forkB,
      metaIfCreate: {
        title: "Fork B",
        owner_id: "system",
        source: "fork-graph-demo",
        parent_decision_id: rootId,
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "forkB-validate-1",
    },
    opts
  );
  if (!r5.ok) console.error("FORK B VALIDATE blocked:", r5.violations);
  assert(r5.ok, "fork b failed");

  // ---- build fork graph ----
  const graph = await buildForkGraph(store, {
    root_decision_id: rootId,
    candidate_decision_ids: [rootId, forkA, forkB],
  });
  assert(graph.ok, "fork graph failed");

  console.log(
    JSON.stringify(
      {
        root_decision_id: rootId,
        graph: graph.graph,
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

