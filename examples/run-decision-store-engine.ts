import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import type { Decision } from "../packages/decision/src/decision.js";
import type { DecisionEvent } from "../packages/decision/src/events.js";
import type { DecisionStore, DecisionEventRecord } from "../packages/decision/src/store.js";

function makeDeterministicNow() {
  let i = 0;
  return () => `2025-01-01T00:00:00.${String(i++).padStart(3, "0")}Z`;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

class InMemoryDecisionStore implements DecisionStore {
  private decisions = new Map<string, Decision>(); // current materialized
  private roots = new Map<string, Decision>(); // root (version=1)
  private events = new Map<string, DecisionEventRecord[]>(); // event log

  async createDecision(decision: Decision): Promise<void> {
    this.roots.set(decision.decision_id, decision);
    this.decisions.set(decision.decision_id, decision);
    if (!this.events.has(decision.decision_id)) this.events.set(decision.decision_id, []);
  }

  async putDecision(decision: Decision): Promise<void> {
    this.decisions.set(decision.decision_id, decision);
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    return this.decisions.get(decision_id) ?? null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    return this.roots.get(decision_id) ?? null;
  }

  async appendEvent(
    decision_id: string,
    input: Omit<DecisionEventRecord, "decision_id" | "seq">
  ): Promise<DecisionEventRecord> {
    const list = this.events.get(decision_id) ?? [];
    const rec: DecisionEventRecord = {
      decision_id,
      seq: list.length + 1,
      at: input.at,
      event: input.event,
    };
    list.push(rec);
    this.events.set(decision_id, list);
    return rec;
  }

  async listEvents(decision_id: string): Promise<DecisionEventRecord[]> {
    return this.events.get(decision_id) ?? [];
  }
}

async function run() {
  const store = new InMemoryDecisionStore();
  const now = makeDeterministicNow();

  const decision_id = "dec_store_1";

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Store Engine", owner_id: "user_1" },
      event: { type: "VALIDATE", actor_id: "user_1" } as const,
    },
    { now }
  );

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "user_1", simulation_snapshot_id: "snap_1" } as const,
    },
    { now }
  );

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "EXPLAIN", actor_id: "user_1", explain_tree_id: "tree_1" } as const,
    },
    { now }
  );

  const cur = await store.getDecision(decision_id);
  assert(cur, "missing current decision");

  console.log(
    JSON.stringify(
      {
        state: cur.state,
        artifacts: cur.artifacts ?? null,
        history_len: cur.history?.length ?? 0,
      },
      null,
      2
    )
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

