// packages/decision/src/snapshots.ts
import type { Decision } from "./decision.js";

/**
 * Hex-encoded SHA-256 hash.
 */
export type HexHash = string;

/**
 * A materialized snapshot of a decision at a specific event sequence.
 */
export type DecisionSnapshot = {
  decision_id: string;

  /**
   * Last event sequence number included in this snapshot.
   */
  up_to_seq: number;

  /**
   * Fully materialized decision state at up_to_seq.
   */
  decision: Decision;

  /**
   * Snapshot creation timestamp (ISO).
   */
  created_at: string;

  /**
   * ✅ Feature 18 / 19 — Snapshot checkpoint hash
   *
   * Must equal the `event.hash` at `up_to_seq`.
   *
   * Enables:
   * - O(delta) verification from snapshot
   * - Snapshot ↔ event-chain integrity guarantees
   */
  checkpoint_hash?: HexHash | null;

  /**
   * ✅ Feature 21 — Decision Merkle Root
   *
   * Merkle root over event hashes [1..up_to_seq] (in seq order).
   * Compact integrity fingerprint of the whole history at this checkpoint.
   *
   * Notes:
   * - null if up_to_seq <= 0
   * - null if any hashes are missing (cannot compute)
   */
  root_hash?: HexHash | null;


  /**
   * ✅ Feature 32: deterministic decision state hash (snapshot decision JSON)
   */
  state_hash?: HexHash | null;

  /**
   * ✅ Feature 14: provenance chain tail hash at this snapshot boundary.
   * This lets us cryptographically bind "decision history up to seq" to its provenance chain.
   */
  provenance_tail_hash?: HexHash | null;




};

/**
 * Snapshot creation policy.
 */
export type SnapshotPolicy = {
  /**
   * Create a snapshot every N events (e.g. 50).
   * If <= 0, snapshotting is disabled.
   */
  every_n_events: number;
};

/**
 * Snapshot retention & pruning policy.
 */
export type SnapshotRetentionPolicy = {
  /**
   * Keep only the last N snapshots.
   */
  keep_last_n_snapshots: number;

  /**
   * If true, delete events with seq <= latest snapshot.up_to_seq.
   */
  prune_events_up_to_latest_snapshot: boolean;
};

/**
 * Storage interface for snapshots.
 */
export type DecisionSnapshotStore = {
  getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null>;
  putSnapshot(snapshot: DecisionSnapshot): Promise<void>;

  // Optional retention helpers
  pruneSnapshots?(
    decision_id: string,
    keep_last_n: number
  ): Promise<{ deleted: number }>;

  pruneEventsUpToSeq?(
    decision_id: string,
    up_to_seq: number
  ): Promise<{ deleted: number }>;

  
};

/**
 * Decide whether a new snapshot should be created.
 */
export function shouldCreateSnapshot(
  policy: SnapshotPolicy,
  current_seq: number,
  last_snapshot_seq: number
): boolean {
  if (!Number.isFinite(policy.every_n_events)) return false;
  if (policy.every_n_events <= 0) return false;
  if (current_seq <= 0) return false;
  return current_seq - last_snapshot_seq >= policy.every_n_events;
}

/**
 * Decide whether events should be pruned after snapshot creation.
 *
 * ✅ Exported because store-engine imports it.
 */
export function shouldPruneEventsAfterSnapshot(
  retention?: SnapshotRetentionPolicy
): boolean {
  return !!retention?.prune_events_up_to_latest_snapshot;
}


/** Back-compat alias (older code may refer to SnapshotStore) */
export type SnapshotStore = DecisionSnapshotStore;

