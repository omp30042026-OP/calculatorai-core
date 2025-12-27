import Database from "better-sqlite3";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionStore } from "./store.js";

type SqliteStoreOptions = {
  path: string; // e.g. ":memory:" or "./decision.db"
};

export class SqliteDecisionStore implements DecisionStore {
  private db: Database.Database;

  constructor(opts: SqliteStoreOptions) {
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        root_json TEXT NOT NULL,
        current_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_events (
        decision_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(decision_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_decision_events_decision_id
        ON decision_events(decision_id);
    `);
  }

  async createDecision(decision: Decision): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO decisions (decision_id, root_json, current_json, created_at, updated_at)
      VALUES (@decision_id, @root_json, @current_json, @created_at, @updated_at)
    `);

    stmt.run({
      decision_id: decision.decision_id,
      root_json: JSON.stringify(decision),
      current_json: JSON.stringify(decision),
      created_at: decision.created_at,
      updated_at: decision.updated_at,
    });
  }

  async putDecision(decision: Decision): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE decisions
      SET current_json = @current_json, updated_at = @updated_at
      WHERE decision_id = @decision_id
    `);

    stmt.run({
      decision_id: decision.decision_id,
      current_json: JSON.stringify(decision),
      updated_at: decision.updated_at,
    });
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT current_json FROM decisions WHERE decision_id = ?`)
      .get(decision_id) as { current_json: string } | undefined;

    return row ? (JSON.parse(row.current_json) as Decision) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT root_json FROM decisions WHERE decision_id = ?`)
      .get(decision_id) as { root_json: string } | undefined;

    return row ? (JSON.parse(row.root_json) as Decision) : null;
  }

  async appendEvent(
    decision_id: string,
    input: { at: string; event: DecisionEvent }
  ): Promise<{ decision_id: string; seq: number; at: string; event: DecisionEvent }> {
    const getNext = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM decision_events
      WHERE decision_id = ?
    `);

    const next = getNext.get(decision_id) as { next_seq: number };
    const seq = next.next_seq;

    const stmt = this.db.prepare(`
      INSERT INTO decision_events (decision_id, seq, event_json)
      VALUES (?, ?, ?)
    `);

    const rec = { decision_id, seq, at: input.at, event: input.event };
    stmt.run(decision_id, seq, JSON.stringify(rec));

    return rec;
  }

  async listEvents(decision_id: string): Promise<{ decision_id: string; seq: number; at: string; event: DecisionEvent }[]> {
    const rows = this.db
      .prepare(`SELECT event_json FROM decision_events WHERE decision_id = ? ORDER BY seq ASC`)
      .all(decision_id) as { event_json: string }[];

    return rows.map((r) => JSON.parse(r.event_json));
  }
}

