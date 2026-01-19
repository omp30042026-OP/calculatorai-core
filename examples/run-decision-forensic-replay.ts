// examples/run-decision-forensic-replay.ts
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { forensicReplayAndVerify } from "../packages/decision/src/forensic.js";

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

  const decision_id = "dec_forensic_001";

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Forensic Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" } as any,
      idempotency_key: "v1",
    },
    { now }
  );

  // enter dispute mode (freeze business actions)
  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "ENTER_DISPUTE", actor_id: "alice", reason: "customer dispute" } as any,
      idempotency_key: "d1",
    },
    { now }
  );

  // audit-safe event allowed in dispute mode
  await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "alice",
        artifacts: { extra: { ticket: "CASE-123" } },
      } as any,
      idempotency_key: "a1",
    },
    { now }
  );

  const report = await forensicReplayAndVerify(store, decision_id);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

