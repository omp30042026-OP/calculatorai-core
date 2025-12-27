// packages/decision/src/store.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type DecisionEventRecord = {
  decision_id: string;
  seq: number;
  at: string; // ISO timestamp
  event: DecisionEvent;

  // V3: safe retries (optional)
  idempotency_key?: string;
};

export type AppendEventInput = Omit<DecisionEventRecord, "decision_id" | "seq"> & {
  idempotency_key?: string;
};

export type DecisionStore = {
  // decisions
  createDecision(decision: Decision): Promise<void>;
  putDecision(decision: Decision): Promise<void>;
  getDecision(decision_id: string): Promise<Decision | null>;
  getRootDecision(decision_id: string): Promise<Decision | null>;

  // events
  appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord>;
  listEvents(decision_id: string): Promise<DecisionEventRecord[]>;

  // V3: helpers (optional but recommended)
  getCurrentVersion?(decision_id: string): Promise<number | null>;
  findEventByIdempotencyKey?(
    decision_id: string,
    key: string
  ): Promise<DecisionEventRecord | null>;

  // V3: atomicity hook (store-engine will use if present)
  runInTransaction?<T>(fn: () => Promise<T>): Promise<T>;
};
