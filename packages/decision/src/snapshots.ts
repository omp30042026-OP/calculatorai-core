// packages/decision/src/snapshots.ts
import type { Decision } from "./decision.js";

export type DecisionSnapshot = {
  decision_id: string;
  up_to_seq: number; // last event seq included in this snapshot
  decision: Decision; // materialized decision at that seq
  created_at: string; // ISO timestamp

  // ✅ Feature 19: snapshot checkpoint to the hash-chain at up_to_seq
  // (hash of the event row with seq === up_to_seq)
  checkpoint_hash?: string | null;
};

export type SnapshotPolicy = {
  // create a snapshot every N events (e.g. 50)
  every_n_events: number;
};

export type SnapshotRetentionPolicy = {
  keep_last_n_snapshots: number;
  prune_events_up_to_latest_snapshot: boolean;
};

export type DecisionSnapshotStore = {
  getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null>;
  putSnapshot(snapshot: DecisionSnapshot): Promise<void>;

  // optional (only some stores support retention/pruning)
  pruneSnapshots?(decision_id: string, keep_last_n: number): Promise<{ deleted: number }>;
  pruneEventsUpToSeq?(decision_id: string, up_to_seq: number): Promise<{ deleted: number }>;
};

export function shouldCreateSnapshot(
  policy: SnapshotPolicy,
  current_seq: number,
  last_snapshot_seq: number
): boolean {
  if (policy.every_n_events <= 0) return false;
  return current_seq - last_snapshot_seq >= policy.every_n_events;
}

// ✅ store-engine imports this, so we must export it
export function shouldPruneEventsAfterSnapshot(retention?: SnapshotRetentionPolicy): boolean {
  return !!retention?.prune_events_up_to_latest_snapshot;
}

