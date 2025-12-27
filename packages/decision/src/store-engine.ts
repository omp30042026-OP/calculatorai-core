import { createDecisionV2 } from "./decision.js";
import { replayDecision } from "./engine.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import type { PolicyViolation } from "./policy.js";
import type { DecisionStore, DecisionEventRecord } from "./store.js";

export type StoreApplyResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

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

  // 1) Load root (version=1) or create it
  let root = await store.getRootDecision(input.decision_id);

  if (!root) {
    root = createDecisionV2(
      {
        decision_id: input.decision_id,
        meta: input.metaIfCreate ?? {},
        version: 1
      },
      now
    );

    await store.createDecision(root);
    await store.putDecision(root);
  }

  // 2) Append event record
  const rec: Omit<DecisionEventRecord, "decision_id" | "seq"> = {
    at: now(),
    event: input.event
  };

  await store.appendEvent(input.decision_id, rec);

  // 3) Replay all stored events deterministically
  const rows = await store.listEvents(input.decision_id);
  const events = rows.map((r) => r.event);

  const rr = replayDecision(root, events, opts);

  if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };

  // 4) Persist “current”
  await store.putDecision(rr.decision);

  return { ok: true, decision: rr.decision, warnings: rr.warnings };
}

