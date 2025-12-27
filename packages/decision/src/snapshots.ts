import type { Decision } from "./decision.js";
import type { DecisionEventRecord } from "./store.js";

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

