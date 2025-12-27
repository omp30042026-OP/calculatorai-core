import type { Decision } from "./decision.js";
import { createDecisionV2 } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { PolicyViolation } from "./policy.js";

import type { DecisionStore, DecisionEventRecord } from "./store.js";

export type StoreApplyResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

const asPromise = <T>(v: T | Promise<T>): Promise<T> => Promise.resolve(v);

/**
 * Store-backed engine (v1):
 * - Ensures root exists
 * - Appends event (as an event record with `at`)
 * - Replays to materialize latest decision
 * - Persists latest decision via store.putDecision()
 */
export async function applyEventWithStore(
  store: DecisionStore,
  input: {
    decision_id: string;
    event: DecisionEvent;
    metaIfCreate?: Record<string, unknown>;
  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  const now = opts.now ?? (() => new Date().toISOString());

  // 1) Load or create root decision
  let root = await asPromise(store.getRootDecision(input.decision_id));
  if (!root) {
    root = createDecisionV2(
      { decision_id: input.decision_id, meta: input.metaIfCreate ?? {} },
      now
    );

    await asPromise(store.createDecision(root));
  }

  // 2) Append event to log (record form)
  const rec: Omit<DecisionEventRecord, "decision_id" | "seq"> = {
    at: now(),
    event: input.event,
  };
  await asPromise(store.appendEvent(input.decision_id, rec));

  // 3) Load event log + replay to get the current decision
  const records = await asPromise(store.listEvents(input.decision_id));
  const events: DecisionEvent[] = records.map((r) => r.event);

  const rr = replayDecision(root, events, opts);
  if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };

  // 4) Persist materialized current decision
  await asPromise(store.putDecision(rr.decision));

  return { ok: true, decision: rr.decision, warnings: rr.warnings };
}

