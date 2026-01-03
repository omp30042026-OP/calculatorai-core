// examples/run-decision-history-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

import { createDecisionV2 } from "../packages/decision/src/decision.js";
import { replayDecision } from "../packages/decision/src/engine.js";

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

async function computeStateAtSeqViaReplay(args: {
  store: SqliteDecisionStore;
  decision_id: string;
  metaIfCreate: Record<string, unknown>;
  upToSeq: number;
  opts: DecisionEngineOptions;
}) {
  const all = await args.store.listEvents(args.decision_id);
  const ordered = [...all].sort((a, b) => a.seq - b.seq);
  const slice = ordered.filter((r) => r.seq <= args.upToSeq).map((r) => r.event);

  // build a clean "creation-time" decision (same meta)
  const base = createDecisionV2(
    { decision_id: args.decision_id, meta: args.metaIfCreate },
    args.opts.now ?? (() => new Date().toISOString())
  );

  const r = replayDecision(base, slice, args.opts);
  assert(r.ok, `replay failed at seq ${args.upToSeq}`);
  return r.decision;
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_history_sqlite_001";

  const metaIfCreate = {
    title: "History Demo",
    owner_id: "system",
    source: "history-demo",
  };

  // seq 1 — VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate,
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "validate-1",
    },
    opts
  );
  assert(r1.ok, "validate failed");

  // seq 2 — SIMULATE
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

  // current materialized
  const cur = await store.getDecision(decision_id);
  assert(cur, "load current decision failed");
  assert(cur.state === "SIMULATED", `expected SIMULATED, got ${cur.state}`);

  // ---- time travel (correct even if snapshots exist) ----
  const at1 = await computeStateAtSeqViaReplay({
    store,
    decision_id,
    metaIfCreate,
    upToSeq: 1,
    opts,
  });
  assert(at1.state === "VALIDATED", `expected VALIDATED, got ${at1.state}`);

  const at2 = await computeStateAtSeqViaReplay({
    store,
    decision_id,
    metaIfCreate,
    upToSeq: 2,
    opts,
  });
  assert(at2.state === "SIMULATED", `expected SIMULATED, got ${at2.state}`);

  console.log(
    JSON.stringify(
      {
        decision_id,
        current_state: cur.state,
        at_seq_1_state: at1.state,
        at_seq_2_state: at2.state,
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

