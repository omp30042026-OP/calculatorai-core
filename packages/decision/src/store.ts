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
   * V6: retention helper — allow pruning old events safely (optional).
   * Implementations should delete events with seq <= up_to_seq for decision_id.
   */
  pruneEventsUpTo?(decision_id: string, up_to_seq: number): Promise<void>;

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

