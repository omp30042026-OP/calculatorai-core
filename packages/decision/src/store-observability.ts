// packages/decision/src/store-observability.ts
import type { DecisionEngineOptions } from "./engine.js";
import type { DecisionSnapshotStore } from "./snapshots.js";
import type { DecisionStore } from "./store.js";

import { getAuditView, type AuditView } from "./store-audit.js";
import { getDecisionTimeline, type DecisionTimeline } from "./store-timeline.js";
import { buildForkLineage, type ForkLineage } from "./store-lineage.js";

export type ObservabilityBundle = {
  decision_id: string;
  audit: AuditView;
  timeline: DecisionTimeline;
  lineage?: ForkLineage;
};

export async function getDecisionObservability(
  store: DecisionStore,
  input: {
    decision_id: string;
    recent_events_limit?: number; // default 25, max 200

    snapStore?: DecisionSnapshotStore;

    // lineage is optional (needs candidate ids)
    root_decision_id?: string;
    candidate_decision_ids?: string[];
  },
  opts: DecisionEngineOptions = {}
): Promise<{ ok: true; bundle: ObservabilityBundle } | { ok: false; error: string }> {
  const audit = await getAuditView(
    store,
    {
      decision_id: input.decision_id,
      recent_events_limit: input.recent_events_limit,
      snapStore: input.snapStore,
    },
    opts
  );
  if (!audit.ok) return { ok: false, error: audit.error };

  const timeline = await getDecisionTimeline(
    store,
    { decision_id: input.decision_id, snapStore: input.snapStore },
    opts
  );
  if (!timeline.ok) return { ok: false, error: timeline.error };

  let lineage: ForkLineage | undefined = undefined;
  if (
    input.root_decision_id &&
    input.candidate_decision_ids &&
    input.candidate_decision_ids.length > 0
  ) {
    const ln = await buildForkLineage(store, {
      root_decision_id: input.root_decision_id,
      candidate_decision_ids: input.candidate_decision_ids,
    });
    if (!ln.ok) return { ok: false, error: ln.error };
    lineage = ln.lineage;
  }

  return {
    ok: true,
    bundle: {
      decision_id: input.decision_id,
      audit: audit.view,
      timeline: timeline.timeline,
      ...(lineage ? { lineage } : {}),
    },
  };
}

