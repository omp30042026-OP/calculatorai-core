import type { Decision } from "./decision.js";
import type { DecisionStore, DecisionEventRecord } from "./store.js";

function clone<T>(x: T): T {
  // Decisions/events are plain JSON-safe objects here
  return JSON.parse(JSON.stringify(x)) as T;
}

export class InMemoryDecisionStore implements DecisionStore {
  private roots = new Map<string, Decision>();
  private currents = new Map<string, Decision>();
  private logs = new Map<string, DecisionEventRecord[]>();

  async createDecision(decision: Decision): Promise<void> {
    if (this.roots.has(decision.decision_id) || this.currents.has(decision.decision_id)) {
      throw new Error(`Decision already exists: ${decision.decision_id}`);
    }
    this.roots.set(decision.decision_id, clone(decision));
    this.currents.set(decision.decision_id, clone(decision));
    this.logs.set(decision.decision_id, []);
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    const d = this.currents.get(decision_id);
    return d ? clone(d) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const d = this.roots.get(decision_id);
    return d ? clone(d) : null;
  }

  async putDecision(decision: Decision): Promise<void> {
    if (!this.currents.has(decision.decision_id)) {
      throw new Error(`Decision not found: ${decision.decision_id}`);
    }
    this.currents.set(decision.decision_id, clone(decision));
  }

  async appendEvent(
    decision_id: string,
    input: Omit<DecisionEventRecord, "decision_id" | "seq">
  ): Promise<DecisionEventRecord> {
    const list = this.logs.get(decision_id);
    if (!list) throw new Error(`Decision not found: ${decision_id}`);

    const seq = list.length + 1;
    const rec: DecisionEventRecord = {
      decision_id,
      seq,
      at: input.at,
      event: clone(input.event),
    };

    list.push(rec);
    return clone(rec);
  }

  async listEvents(decision_id: string): Promise<DecisionEventRecord[]> {
    const list = this.logs.get(decision_id);
    if (!list) return [];
    return clone(list).sort((a, b) => a.seq - b.seq);
  }
}

