// examples/run-decision-diff-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { diffDecisionBetweenSeqs } from "../packages/decision/src/store-diff.js";

// assert
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// deterministic now()
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

  const decision_id = "dec_diff_sqlite_001";

  // seq1 VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Diff Demo", owner_id: "system", source: "diff-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq2 SIMULATE
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

  // seq3 attach artifacts
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        artifacts: {
          explain_tree_id: "tree_diff_001",
          extra: { note: "diff demo" },
        },
      },
      idempotency_key: "attach-1",
    },
    opts
  );
  assert(r3.ok, "attach failed");

  // diff seq1 -> seq3
  const d = await diffDecisionBetweenSeqs(
    store,
    { decision_id, from_seq: 1, to_seq: 3 },
    opts
  );
  assert(d.ok, "diff failed");

  console.log(JSON.stringify(d.diff, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

