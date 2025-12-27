// packages/decision/src/store.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

/**
 * One persisted event row.
 * `idempotency_key` is optional but strongly recommended for safe retries.
 */
export type DecisionEventRecord = {
  decision_id: string;
  seq: number; // monotonically increasing per decision_id
  at: string; // ISO timestamp
  event: DecisionEvent;
  idempotency_key?: string | null;
};

/**
 * Input for appending a new event (store assigns decision_id + seq).
 */
export type AppendEventInput = Omit<DecisionEventRecord, "decision_id" | "seq">;

/**
 * Optional snapshot row (materialized state at a given seq).
 * Used to speed up replay for long event streams.
 */
export type DecisionSnapshotRecord = {
  decision_id: string;
  seq: number; // snapshot is valid after applying events up to this seq
  at: string; // ISO timestamp
  decision: Decision;
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

  // OPTIONAL: efficient delta read for snapshots (events with seq > after_seq)
  listEventsFrom?(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]>;

  /**
   * Optional helper to fetch only events after a seq.
   * If not provided, store-engine will fall back to listEvents() + filter.
   */
  listEventsAfter?(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]>;

  /**
   * Optional snapshot helpers
   */
  getLatestSnapshot?(decision_id: string): Promise<DecisionSnapshotRecord | null>;
  saveSnapshot?(snap: DecisionSnapshotRecord): Promise<void>;

  /**
   * Optional helpers for stronger guarantees in store-engine.
   * If not provided, store-engine falls back to simpler behavior.
   */
  getCurrentVersion?(decision_id: string): Promise<number | null>;
  findEventByIdempotencyKey?(
    decision_id: string,
    idempotency_key: string
  ): Promise<DecisionEventRecord | null>;
};

