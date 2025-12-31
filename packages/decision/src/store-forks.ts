// packages/decision/src/store-forks.ts
import type { Decision } from "./decision.js";
import type { DecisionEngineOptions } from "./engine.js";
import type { DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";
import { getDecisionAtSeq } from "./store-history.js";

export async function forkDecisionAtSeq(
  store: DecisionStore,
  input: {
    from_decision_id: string;
    targetSeq: number;
    new_decision_id: string;
    metaIfCreate?: Record<string, unknown>;
    snapshotStore?: DecisionSnapshotStore;
  },
  opts: DecisionEngineOptions = {}
): Promise<Decision> {
  const base = await getDecisionAtSeq(
    store,
    input.from_decision_id,
    input.targetSeq,
    opts,
    input.snapshotStore
  );

  if (!base) {
    throw new Error(
      `Cannot fork: decision ${input.from_decision_id} not found (or missing root).`
    );
  }

  // Deep clone to detach references
  const forked = JSON.parse(JSON.stringify(base)) as Decision;

  // New identity + provenance
  forked.decision_id = input.new_decision_id;
  forked.meta = {
    ...(forked.meta ?? {}),
    ...(input.metaIfCreate ?? {}),
    forked_from: { decision_id: input.from_decision_id, up_to_seq: input.targetSeq },
  };

  // Persist as BOTH root + current for the new decision_id
  await store.createDecision(forked);
  await store.putDecision(forked);

  return forked;
}

