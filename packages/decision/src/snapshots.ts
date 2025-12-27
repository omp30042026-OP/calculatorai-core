// packages/decision/src/snapshots.ts
import type { Decision } from "./decision.js";

export type DecisionSnapshot = {
  decision_id: string;
  // last event seq included in this snapshot
  up_to_seq: number;
  // materialized decision at that seq
  decision: Decision;
  // snapshot creation time (string ISO)
  created_at: string;
};

export type SnapshotPolicy = {
  // create a snapshot every N events (e.g. 50)
  every_n_events: number;
};

export type DecisionSnapshotStore = {
  getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null>;
  putSnapshot(snapshot: DecisionSnapshot): Promise<void>;
};

export function shouldCreateSnapshot(
  policy: SnapshotPolicy,
  last_event_seq: number,
  last_snapshot_seq: number
): boolean {
  if (policy.every_n_events <= 0) return false;
  return last_event_seq - last_snapshot_seq >= policy.every_n_events;
}

