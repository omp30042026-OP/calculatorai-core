// packages/decision/src/store-audit.ts
import type { Decision } from "./decision.js";
import type { DecisionEngineOptions } from "./engine.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";
import { diffDecisionBetweenSeqs, type DecisionDiff } from "./store-diff.js";
import { DecisionAuditSchema, type DecisionAudit } from "./audit-schema.js";

export type AuditView = {
  decision_id: string;

  // current materialized
  current: Decision | null;

  // snapshot info (if store supports it)
  latest_snapshot: DecisionSnapshot | null;

  // last N event records
  recent_events: DecisionEventRecord[];

  // optional diff block
  diff?: DecisionDiff | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

async function listRecentEvents(
  store: DecisionStore,
  decision_id: string,
  limit: number
): Promise<DecisionEventRecord[]> {
  if (limit <= 0) return [];

  // ✅ Fast path (V10)
  if (store.listEventsTail) {
    return store.listEventsTail(decision_id, limit);
  }

  // Fallback (works everywhere)
  const all = await store.listEvents(decision_id);
  if (all.length <= limit) return all;
  return all.slice(all.length - limit);
}

function toAuditEvent(rec: DecisionEventRecord) {
  const e: any = rec.event;
  return {
    seq: rec.seq,
    at: rec.at,
    type: e?.type ?? "UNKNOWN",
    actor_id: typeof e?.actor_id === "string" ? e.actor_id : undefined,
    meta: e?.meta && typeof e.meta === "object" ? (e.meta as Record<string, unknown>) : undefined,
  };
}

/**
 * V11: stable audit contract
 * Returns:
 *  - view: "raw" detailed view (Decision + snapshot + full event records + diff)
 *  - audit: validated JSON-safe audit payload for UI/API
 */
export async function getAuditView(
  store: DecisionStore,
  input: {
    decision_id: string;
    recent_events_limit?: number; // default 25, max 200
    snapStore?: DecisionSnapshotStore;

    // If provided => include diff
    diff_from_seq?: number;
    diff_to_seq?: number;
  },
  opts: DecisionEngineOptions = {}
): Promise<
  | { ok: true; view: AuditView; audit: DecisionAudit }
  | { ok: false; error: string }
> {
  try {
    const decision_id = input.decision_id;
    const limit = clamp(input.recent_events_limit ?? 25, 0, 200);

    const current = await store.getDecision(decision_id);

    const latest_snapshot = input.snapStore
      ? await input.snapStore.getLatestSnapshot(decision_id)
      : null;

    const recent_events = await listRecentEvents(store, decision_id, limit);

    let diff: DecisionDiff | null | undefined = undefined;
    if (typeof input.diff_from_seq === "number" && typeof input.diff_to_seq === "number") {
      const d = await diffDecisionBetweenSeqs(
        store,
        {
          decision_id,
          from_seq: input.diff_from_seq,
          to_seq: input.diff_to_seq,
          snapStore: input.snapStore,
        },
        opts
      );
      diff = d.ok ? d.diff : null;
    }

    const view: AuditView = {
      decision_id,
      current,
      latest_snapshot,
      recent_events,
      ...(diff !== undefined ? { diff } : {}),
    };

    // ✅ Build validated audit payload for UI/API
    const auditCandidate = {
      decision_id,
      state: current?.state ?? "MISSING",
      version: current?.version ?? 0,
      meta: current?.meta ?? undefined,
      recent_events: recent_events.map(toAuditEvent),
      // warnings/violations intentionally omitted here (audit view is store-focused)
    };

    const audit = DecisionAuditSchema.parse(auditCandidate);

    return { ok: true, view, audit };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

