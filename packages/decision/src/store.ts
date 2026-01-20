// packages/decision/src/store.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

/**
 * One persisted event row.
 * `idempotency_key` is optional but strongly recommended for safe retries.
 *
 * ✅ Feature 17: Tamper-evident audit trail (hash-chain)
 */
export type DecisionEventRecord = {
  decision_id: string;
  seq: number; // monotonically increasing per decision_id
  at: string; // ISO timestamp
  event: DecisionEvent;
  idempotency_key?: string | null;

  // ✅ Feature 17 (optional for backwards compatibility)
  prev_hash?: string | null;
  hash?: string | null;
};

/**
 * Input for appending a new event (store assigns decision_id + seq).
 *
 * ✅ Feature 17:
 * - caller does NOT provide hashes; store computes them.
 */
export type AppendEventInput = Omit<
  DecisionEventRecord,
  "decision_id" | "seq" | "prev_hash" | "hash"
>;

/**
 * ✅ Feature 23: Merkle inclusion proof for a single event hash.
 *
 * siblings are ordered bottom-up (leaf -> root).
 */
export type MerkleProofStep = {
  hash: string;
  position: "left" | "right";
};

export type MerkleProof = {
  decision_id: string;
  up_to_seq: number;
  seq: number;
  leaf_hash: string;
  siblings: MerkleProofStep[];
};

export type DecisionStore = {
  // decisions
  createDecision(decision: Decision): Promise<void>;
  putDecision(decision: Decision): Promise<void>;
  getDecision(decision_id: string): Promise<Decision | null>;
  getRootDecision(decision_id: string): Promise<Decision | null>;

  // events (append-only)
  appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord>;
  listEvents(decision_id: string): Promise<DecisionEventRecord[]>;

  /**
   * V5: paging helper — return events with seq > after_seq (ordered).
   * If not provided, store-engine will fall back to listEvents + filter.
   */
  listEventsFrom?(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]>;

  /**
   * ✅ Feature 19/20:
   * Fast read for a single event by seq (used for verification & proofs).
   */
  getEventBySeq?(decision_id: string, seq: number): Promise<DecisionEventRecord | null>;

  /**
   * V10: tail helper — return last N events (ordered ASC).
   * Store-audit uses this to avoid full scans.
   */
  listEventsTail?(decision_id: string, limit: number): Promise<DecisionEventRecord[]>;

  /**
   * ✅ Feature 17 (optional):
   * Fast read for the last event hash to avoid scanning.
   */
  getLastEvent?(decision_id: string): Promise<DecisionEventRecord | null>;

  /**
   * ✅ Feature 23:
   * Build an inclusion proof for event at `seq`, proving membership in
   * the history up to `up_to_seq` (usually snapshot.up_to_seq).
   */
  getMerkleProof?(decision_id: string, seq: number, up_to_seq: number): Promise<MerkleProof | null>;

  /**
   * Optional helpers for stronger guarantees in store-engine.
   */
  runInTransaction?<T>(fn: () => Promise<T>): Promise<T>;
  getCurrentVersion?(decision_id: string): Promise<number | null>;
  findEventByIdempotencyKey?(
    decision_id: string,
    idempotency_key: string
  ): Promise<DecisionEventRecord | null>;
};







