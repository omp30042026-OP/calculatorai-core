// packages/decision/src/sqlite-store.ts
import Database from "better-sqlite3";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { AppendEventInput, DecisionEventRecord, DecisionStore } from "./store.js";

export class SqliteDecisionStore implements DecisionStore {
  private db: Database.Database;

  constructor(filename = "decision-store.sqlite") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  // ---- atomic transaction hook (SYNC for better-sqlite3) ----
  runInTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(() => fn());
    return tx();
  }

  private columnExists(table: string, col: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT NOT NULL,
        version     INTEGER NOT NULL,
        is_root     INTEGER NOT NULL DEFAULT 0,
        is_current  INTEGER NOT NULL DEFAULT 0,
        decision_json TEXT NOT NULL,
        PRIMARY KEY (decision_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_current
        ON decisions(decision_id, is_current);

      CREATE INDEX IF NOT EXISTS idx_decisions_root
        ON decisions(decision_id, is_root);

      CREATE TABLE IF NOT EXISTS decision_events (
        decision_id TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        at          TEXT NOT NULL,
        event_json  TEXT NOT NULL,
        idempotency_key TEXT,
        PRIMARY KEY (decision_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_decision
        ON decision_events(decision_id, seq);
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
        ON decision_events(decision_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    if (!this.columnExists("decision_events", "idempotency_key")) {
      this.db.exec(`ALTER TABLE decision_events ADD COLUMN idempotency_key TEXT;`);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
          ON decision_events(decision_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `);
    }
  }

  async createDecision(decision: Decision): Promise<void> {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO decisions(decision_id, version, is_root, is_current, decision_json)
        VALUES (@decision_id, @version, @is_root, 0, @decision_json)
      `
      )
      .run({
        decision_id: decision.decision_id,
        version: decision.version,
        is_root: decision.version === 1 ? 1 : 0,
        decision_json: JSON.stringify(decision),
      });
  }

  async putDecision(decision: Decision): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE decisions SET is_current = 0 WHERE decision_id = ?`)
        .run(decision.decision_id);

      this.db
        .prepare(
          `
          INSERT INTO decisions(decision_id, version, is_root, is_current, decision_json)
          VALUES (@decision_id, @version, @is_root, 1, @decision_json)
          ON CONFLICT(decision_id, version)
          DO UPDATE SET
            is_root = excluded.is_root,
            is_current = 1,
            decision_json = excluded.decision_json
        `
        )
        .run({
          decision_id: decision.decision_id,
          version: decision.version,
          is_root: decision.version === 1 ? 1 : 0,
          decision_json: JSON.stringify(decision),
        });
    });

    tx();
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(
        `SELECT decision_json FROM decisions WHERE decision_id = ? AND is_current = 1 LIMIT 1`
      )
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT decision_json FROM decisions WHERE decision_id = ? AND is_root = 1 LIMIT 1`)
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getCurrentVersion(decision_id: string): Promise<number | null> {
    const row = this.db
      .prepare(`SELECT version FROM decisions WHERE decision_id = ? AND is_current = 1 LIMIT 1`)
      .get(decision_id) as { version: number } | undefined;
    return row ? row.version : null;
  }

  async findEventByIdempotencyKey(
    decision_id: string,
    key: string
  ): Promise<DecisionEventRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key
         FROM decision_events
         WHERE decision_id = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .get(decision_id, key) as
      | { decision_id: string; seq: number; at: string; event_json: string; idempotency_key: string }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event_json) as DecisionEvent,
      idempotency_key: row.idempotency_key,
    };
  }

  async appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord> {
    if (input.idempotency_key) {
      const existing = await this.findEventByIdempotencyKey(decision_id, input.idempotency_key);
      if (existing) return existing;
    }

    const nextSeqRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM decision_events WHERE decision_id = ?`
      )
      .get(decision_id) as { next_seq: number };

    const rec: DecisionEventRecord = {
      decision_id,
      seq: nextSeqRow.next_seq,
      at: input.at,
      event: input.event,
      ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    };

    this.db
      .prepare(
        `INSERT INTO decision_events(decision_id, seq, at, event_json, idempotency_key)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        rec.decision_id,
        rec.seq,
        rec.at,
        JSON.stringify(rec.event),
        rec.idempotency_key ?? null
      );

    return rec;
  }

  async listEvents(decision_id: string): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key
         FROM decision_events
         WHERE decision_id = ?
         ORDER BY seq ASC`
      )
      .all(decision_id) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
    }>;

    return rows.map((r) => ({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.event_json) as DecisionEvent,
      ...(r.idempotency_key ? { idempotency_key: r.idempotency_key } : {}),
    }));
  }
}

