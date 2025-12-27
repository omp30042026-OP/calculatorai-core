import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type DecisionEventRecord = {
  decision_id: string;
  seq: number; // strictly increasing per decision_id
  at: string; // ISO timestamp when the event was recorded
  event: DecisionEvent;
};

/**
 * DecisionStore V1
 * - Stores the "root" (initial) decision for deterministic replay
 * - Stores the "current" (latest) decision snapshot
 * - Stores an append-only event log
 */
export interface DecisionStore {
  /** Create a new decision (root + current). Must not already exist. */
  createDecision(decision: Decision): Promise<void>;

  /** Read current snapshot. */
  getDecision(decision_id: string): Promise<Decision | null>;

  /** Read root snapshot (initial). */
  getRootDecision(decision_id: string): Promise<Decision | null>;

  /** Overwrite current snapshot (used after applying events). */
  putDecision(decision: Decision): Promise<void>;

  /** Append an event record (append-only). Returns the stored record (with seq). */
  appendEvent(
    decision_id: string,
    input: Omit<DecisionEventRecord, "decision_id" | "seq">
  ): Promise<DecisionEventRecord>;

  /** Read the full event log in order. */
  listEvents(decision_id: string): Promise<DecisionEventRecord[]>;
}

