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

  // V3+: safe retry / dedupe (store may enforce uniqueness per decision_id)
  idempotency_key?: string | null;
};

/**
 * Input for appending a new event (store assigns decision_id + seq).
 */
export type AppendEventInput = Omit<DecisionEventRecord, "decision_id" | "seq">;

/**
 * DecisionStore (V5 contract)
 * - Root decision is immutable once created.
 * - Current decision is the latest materialized view after replay.
 * - Events are append-only and ordered by seq.
 */
export type DecisionStore = {
  // -------- decisions --------
  createDecision(decision: Decision): Promise<void>; // ensures root exists (idempotent)
  putDecision(decision: Decision): Promise<void>; // upserts current
  getDecision(decision_id: string): Promise<Decision | null>; // current
  getRootDecision(decision_id: string): Promise<Decision | null>; // root

  // -------- events (append-only) --------
  appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord>;
  listEvents(decision_id: string): Promise<DecisionEventRecord[]>;

  /**
   * V5: paging helper — return events with seq > after_seq (ordered ASC).
   * If not provided, store-engine falls back to listEvents + filter.
   */
  listEventsFrom?(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]>;

  // -------- optional helpers (stronger guarantees) --------

  /**
   * If provided, store-engine will wrap apply in one atomic transaction.
   * Must be safe for async callbacks (no returning Promise from better-sqlite3 transaction()).
   */
  runInTransaction?<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Best-effort optimistic locking helper.
   * Usually returns current decision.version (or null if missing).
   */
  getCurrentVersion?(decision_id: string): Promise<number | null>;

  /**
   * Optional idempotency lookup (pair with unique index on (decision_id, idempotency_key)).
   */
  findEventByIdempotencyKey?(
    decision_id: string,
    idempotency_key: string
  ): Promise<DecisionEventRecord | null>;
};

