// packages/decision/src/store-timeline.ts
import type { Decision } from "./decision.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

export type TimelineEntry = {
  seq: number;
  at: string;
  event: unknown;

  // materialized after applying this event
  state_after: string;
  version_after: number;

  // optional: whether this seq is covered by latest snapshot
  covered_by_latest_snapshot?: boolean;
};

export type DecisionTimeline = {
  decision_id: string;
  from_seq: number;
  to_seq: number;
  entries: TimelineEntry[];
};

async function loadEventsRange(
  store: DecisionStore,
  decision_id: string,
  from_seq: number,
  to_seq: number
): Promise<DecisionEventRecord[]> {
  const rows = store.listEventsFrom
    ? await store.listEventsFrom(decision_id, Math.max(0, from_seq - 1))
    : await store.listEvents(decision_id);

  return rows.filter((r) => r.seq >= from_seq && r.seq <= to_seq);
}

export async function getDecisionTimeline(
  store: DecisionStore,
  input: {
    decision_id: string;

    // Provide either:
    from_seq?: number; // default 1
    to_seq?: number; // default latest
    limit?: number; // if set, take last N events (overrides from/to)

    snapStore?: DecisionSnapshotStore;
  },
  opts: DecisionEngineOptions = {}
): Promise<{ ok: true; timeline: DecisionTimeline } | { ok: false; error: string }> {
  const decision_id = input.decision_id;

  const root = await store.getRootDecision(decision_id);
  if (!root) return { ok: false, error: "root decision not found" };

  // Determine seq bounds
  const allEvents = await store.listEvents(decision_id);
  const latestSeq = allEvents.length ? allEvents[allEvents.length - 1]!.seq : 0;

  if (latestSeq === 0) {
    return {
      ok: true,
      timeline: { decision_id, from_seq: 0, to_seq: 0, entries: [] },
    };
  }

  let from_seq = input.from_seq ?? 1;
  let to_seq = input.to_seq ?? latestSeq;

  if (typeof input.limit === "number" && input.limit > 0) {
    to_seq = latestSeq;
    from_seq = Math.max(1, latestSeq - input.limit + 1);
  }

  if (from_seq > to_seq) [from_seq, to_seq] = [to_seq, from_seq];

  // Choose base decision for replay
  const latestSnap = input.snapStore ? await input.snapStore.getLatestSnapshot(decision_id) : null;

  // Only use snapshot if it’s <= from_seq - 1 (safe base)
  const baseSnap =
    latestSnap && latestSnap.up_to_seq <= Math.max(0, from_seq - 1) ? latestSnap : null;

  const baseDecision: Decision = baseSnap?.decision ?? root;
  const baseSeq = baseSnap?.up_to_seq ?? 0;

  // Load events (baseSeq+1 ... to_seq) and then slice to from_seq..to_seq
  const needed = await loadEventsRange(store, decision_id, baseSeq + 1, to_seq);

  // Replay step-by-step so we can output state after each event
  let cur: Decision = baseDecision;
  const entries: TimelineEntry[] = [];

  for (const rec of needed) {
    const rr = replayDecision(cur, [rec.event as any], opts);
    cur = rr.decision;

    if (rec.seq >= from_seq) {
      entries.push({
        seq: rec.seq,
        at: rec.at,
        event: rec.event as any,
        state_after: (cur as any).state ?? "UNKNOWN",
        version_after: (cur as any).version ?? -1,
        ...(latestSnap
          ? { covered_by_latest_snapshot: rec.seq <= latestSnap.up_to_seq }
          : {}),
      });
    }
  }

  return {
    ok: true,
    timeline: {
      decision_id,
      from_seq,
      to_seq,
      entries,
    },
  };
}

