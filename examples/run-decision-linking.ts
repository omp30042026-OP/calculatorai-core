// examples/run-decision-linking.ts
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

  const a = "dec_graph_A";
  const b = "dec_graph_B";

  await applyEventWithStore(
    store,
    { decision_id: a, metaIfCreate: { title: "A", owner_id: "system" }, event: { type: "VALIDATE", actor_id: "alice" }, idempotency_key: "a_v1" },
    opts
  );

  await applyEventWithStore(
    store,
    { decision_id: b, metaIfCreate: { title: "B", owner_id: "system" }, event: { type: "VALIDATE", actor_id: "bob" }, idempotency_key: "b_v1" },
    opts
  );

  const link1 = await applyEventWithStore(
    store,
    {
      decision_id: a,
      event: {
        type: "LINK_DECISIONS",
        actor_id: "alice",
        links: [
          { to_decision_id: b, relation: "DEPENDS_ON", note: "A rollout depends on B being live" },
        ],
      } as any,
      idempotency_key: "a_link_1",
    },
    opts
  );

  // Duplicate edge updates (dedupe by to_decision_id + relation)
  const link2 = await applyEventWithStore(
    store,
    {
      decision_id: a,
      event: {
        type: "LINK_DECISIONS",
        actor_id: "alice",
        links: [
          { to_decision_id: b, relation: "DEPENDS_ON", confidence: 0.9 },
        ],
      } as any,
      idempotency_key: "a_link_2",
    },
    opts
  );

  process.stdout.write(JSON.stringify({ link1, link2 }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

