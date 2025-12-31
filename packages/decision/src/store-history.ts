// packages/decision/src/store-history.ts
import type { Decision } from "./decision.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

type SnapshotAtOrBeforeCapable = DecisionSnapshotStore & {
  getSnapshotAtOrBefore: (decision_id: string, targetSeq: number) => Promise<DecisionSnapshot | null>;
};

function hasGetSnapshotAtOrBefore(
  snapStore: DecisionSnapshotStore
): snapStore is SnapshotAtOrBeforeCapable {
  return typeof (snapStore as any).getSnapshotAtOrBefore === "function";
}

async function loadEventsUpToSeq(
  store: DecisionStore,
  decision_id: string,
  after_seq: number,
  up_to_seq: number
): Promise<DecisionEventRecord[]> {
  const rows = store.listEventsFrom
    ? await store.listEventsFrom(decision_id, after_seq)
    : (await store.listEvents(decision_id)).filter((r) => r.seq > after_seq);

  return rows.filter((r) => r.seq <= up_to_seq);
}

/**
 * V7: reconstruct the decision state at a specific event seq.
 * Uses snapshot at/before targetSeq if available; otherwise falls back safely.
 */
export async function getDecisionAtSeq(
  store: DecisionStore,
  decision_id: string,
  targetSeq: number,
  opts: DecisionEngineOptions = {},
  snapStore?: DecisionSnapshotStore
): Promise<Decision | null> {
  const root = await store.getRootDecision(decision_id);
  if (!root) return null;

  // Prefer: snapshot at/before targetSeq if the store supports it
  const snap = snapStore
    ? hasGetSnapshotAtOrBefore(snapStore)
      ? await snapStore.getSnapshotAtOrBefore(decision_id, targetSeq)
      : await snapStore.getLatestSnapshot(decision_id)
    : null;

  // If fallback latest snapshot is *after* targetSeq, ignore it (unsafe)
  const usableSnap = snap && snap.up_to_seq <= targetSeq ? snap : null;

  const baseDecision = usableSnap?.decision ?? root;
  const baseSeq = usableSnap?.up_to_seq ?? 0;

  const delta = await loadEventsUpToSeq(store, decision_id, baseSeq, targetSeq);
  const rr = replayDecision(baseDecision, delta.map((r) => r.event), opts);

  return rr.decision;
}

