// packages/decision/src/snapshots.ts
import type { Decision } from "./decision.js";

export type DecisionSnapshot = {
  decision_id: string;
  up_to_seq: number; // last event seq included in this snapshot
  decision: Decision; // materialized decision at that seq
  created_at: string; // ISO timestamp
};

export type SnapshotPolicy = {
  // create a snapshot every N events (e.g. 50)
  every_n_events: number;
};

/**
 * V6: retention policy (bounded storage)
 */
export type SnapshotRetentionPolicy = {
  // keep last N snapshots per decision_id (e.g. 10)
  keep_last_n_snapshots: number;

  // if true, prune events up to the latest snapshot seq after pruning snapshots
  prune_events_up_to_latest_snapshot?: boolean;
};

export type DecisionSnapshotStore = {
  getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null>;
  putSnapshot(snapshot: DecisionSnapshot): Promise<void>;

  // V6 optional maintenance hooks
  pruneSnapshots?(
    decision_id: string,
    keep_last_n: number
  ): Promise<{ deleted: number }>;

  pruneEventsUpToSeq?(
    decision_id: string,
    up_to_seq: number
  ): Promise<{ deleted: number }>;
};

export function shouldCreateSnapshot(
  policy: SnapshotPolicy,
  current_seq: number,
  last_snapshot_seq: number
): boolean {
  if (policy.every_n_events <= 0) return false;
  return current_seq - last_snapshot_seq >= policy.every_n_events;
}

