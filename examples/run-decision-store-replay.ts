import { createDecisionV2, applyDecisionEvent, replayDecision } from "../packages/decision/src/engine.js";
import { InMemoryDecisionStore } from "../packages/decision/src/in-memory-store.js";
import type { DecisionEvent } from "../packages/decision/src/events.js";

function makeDeterministicNow(start = 1_700_000_000_000) {
  let t = start;
  return () => new Date(t++).toISOString();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const now = makeDeterministicNow();
  const store = new InMemoryDecisionStore();

  // 1) Create root decision and store it
  const decision_id = "dec_store_1";

  // NOTE: createDecisionV2 signature in your codebase is (input, nowFn)
  const root = createDecisionV2(
    {
      decision_id,
      meta: { title: "Store Replay", owner_id: "user_1" },
      artifacts: {},
    },
    now
  );

  await store.createDecision(root);

  // 2) Apply events one-by-one, append to log, persist current snapshot
  const events: DecisionEvent[] = [
    { type: "VALIDATE", actor_id: "user_1" },
    { type: "ATTACH_ARTIFACTS", actor_id: "user_1", artifacts: { margin_snapshot_id: "m_001" } },
    { type: "SIMULATE", actor_id: "user_1" },
    { type: "EXPLAIN", actor_id: "user_1" },
  ];

  let cur = root;
  for (const e of events) {
    const r = applyDecisionEvent(cur, e, { now });
    assert(r.ok, `applyDecisionEvent failed: ${JSON.stringify(r, null, 2)}`);
    cur = r.decision;

    await store.appendEvent(decision_id, { at: now(), event: e });
    await store.putDecision(cur);
  }

  const storedCurrent = await store.getDecision(decision_id);
  assert(storedCurrent !== null, "missing current snapshot");

  // 3) Replay from root + stored events and compare important invariants
  const storedRoot = await store.getRootDecision(decision_id);
  assert(storedRoot !== null, "missing root snapshot");

  const log = await store.listEvents(decision_id);
  const replayEvents = log.map((x) => x.event);

  const rr = replayDecision(storedRoot, replayEvents, { now: makeDeterministicNow() });
  assert(rr.ok, `replayDecision failed: ${JSON.stringify(rr, null, 2)}`);

  // Compare core invariants (ignore timestamps)
  assert(rr.decision.state === storedCurrent.state, "state mismatch after replay");

  const a1 = JSON.stringify(rr.decision.artifacts ?? {});
  const a2 = JSON.stringify(storedCurrent.artifacts ?? {});
  assert(a1 === a2, "artifacts mismatch after replay");

  assert(
    (rr.decision.history?.length ?? 0) === (storedCurrent.history?.length ?? 0),
    "history length mismatch after replay"
  );

  console.log("✅ Decision store replay ok:", {
    state: rr.decision.state,
    artifacts: rr.decision.artifacts ?? {},
    events: log.length,
  });
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

