// examples/run-decision-timeline-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { getDecisionTimeline } from "../packages/decision/src/store-timeline.js";

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

  const decision_id = "dec_timeline_sqlite_001";

  // seq 1
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Timeline Demo", owner_id: "system", source: "timeline-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq 2
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

  // seq 3 (adds something visible in timeline)
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        artifacts: { extra: { note: "timeline tick" } },
      },
      idempotency_key: "attach-1",
    },
    opts
  );
  assert(r3.ok, "attach failed");

    const tl = await getDecisionTimeline(
    store,
    {
      decision_id,
      limit: 50,
    },
    opts
  );
  assert(tl.ok, "timeline failed");

  console.log(
    JSON.stringify(
      {
        decision_id,
        timeline: tl.timeline,
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

