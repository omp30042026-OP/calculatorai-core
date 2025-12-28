// packages/decision/src/sqlite-store.ts
import Database from "better-sqlite3";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { AppendEventInput, DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

export class SqliteDecisionStore implements DecisionStore, DecisionSnapshotStore {
  private db: Database.Database;
  private txDepth = 0;

  constructor(filename = "decision-store.sqlite") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  // ✅ Async-safe transaction wrapper (no better-sqlite3 transaction(fn) here)
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // allow nested calls safely
    if (this.txDepth > 0) return fn();

    this.txDepth++;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const out = await fn();
      this.db.exec("COMMIT;");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback failures
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id   TEXT NOT NULL,
        kind          TEXT NOT NULL, -- 'root' | 'current'
        decision_json TEXT NOT NULL,
        PRIMARY KEY (decision_id, kind)
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_kind
        ON decisions(decision_id, kind);

      CREATE TABLE IF NOT EXISTS decision_events (
        decision_id      TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        at               TEXT NOT NULL,
        event_json       TEXT NOT NULL,
        idempotency_key  TEXT,
        PRIMARY KEY (decision_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_decision
        ON decision_events(decision_id, seq);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
        ON decision_events(decision_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS decision_snapshots (
        decision_id   TEXT NOT NULL,
        up_to_seq     INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        PRIMARY KEY (decision_id, up_to_seq)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_latest
        ON decision_snapshots(decision_id, up_to_seq DESC);
    `);
  }

  // ---------------- decisions ----------------

  async createDecision(decision: Decision): Promise<void> {
    // ✅ root stored separately and never overwritten
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO decisions(decision_id, kind, decision_json)
        VALUES (?, 'root', ?)
      `
      )
      .run(decision.decision_id, JSON.stringify(decision));
  }

  async putDecision(decision: Decision): Promise<void> {
    // ✅ only updates 'current'
    this.db
      .prepare(
        `
        INSERT INTO decisions(decision_id, kind, decision_json)
        VALUES (?, 'current', ?)
        ON CONFLICT(decision_id, kind)
        DO UPDATE SET decision_json = excluded.decision_json
      `
      )
      .run(decision.decision_id, JSON.stringify(decision));
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(
        `SELECT decision_json
         FROM decisions
         WHERE decision_id = ? AND kind = 'current'
         LIMIT 1`
      )
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(
        `SELECT decision_json
         FROM decisions
         WHERE decision_id = ? AND kind = 'root'
         LIMIT 1`
      )
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getCurrentVersion(decision_id: string): Promise<number | null> {
    const cur = await this.getDecision(decision_id);
    return cur?.version ?? null;
  }

  // ---------------- events ----------------

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
      | {
          decision_id: string;
          seq: number;
          at: string;
          event_json: string;
          idempotency_key: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event_json) as DecisionEvent,
      idempotency_key: row.idempotency_key ?? null,
    };
  }

  async appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord> {
    // idempotency shortcut
    if (input.idempotency_key) {
      const existing = await this.findEventByIdempotencyKey(decision_id, input.idempotency_key);
      if (existing) return existing;
    }

    // next seq
    const nextSeqRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM decision_events
         WHERE decision_id = ?`
      )
      .get(decision_id) as { next_seq: number };

    const rec: DecisionEventRecord = {
      decision_id,
      seq: nextSeqRow.next_seq,
      at: input.at,
      event: input.event,
      idempotency_key: input.idempotency_key ?? null,
    };

    try {
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
    } catch (e: any) {
      // if unique idempotency index tripped, return existing
      if (input.idempotency_key) {
        const existing = await this.findEventByIdempotencyKey(decision_id, input.idempotency_key);
        if (existing) return existing;
      }
      throw e;
    }

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
      idempotency_key: r.idempotency_key ?? null,
    }));
  }

  // ✅ efficient delta fetch for snapshots
  async listEventsFrom(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key
         FROM decision_events
         WHERE decision_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(decision_id, after_seq) as Array<{
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
      idempotency_key: r.idempotency_key ?? null,
    }));
  }

  // ---------------- snapshots ----------------

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id, up_to_seq, created_at, decision_json
         FROM decision_snapshots
         WHERE decision_id = ?
         ORDER BY up_to_seq DESC
         LIMIT 1`
      )
      .get(decision_id) as
      | { decision_id: string; up_to_seq: number; created_at: string; decision_json: string }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      up_to_seq: row.up_to_seq,
      created_at: row.created_at,
      decision: JSON.parse(row.decision_json) as Decision,
    };
  }

  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decision_snapshots(decision_id, up_to_seq, created_at, decision_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        snapshot.decision_id,
        snapshot.up_to_seq,
        snapshot.created_at,
        JSON.stringify(snapshot.decision)
      );
  }

  // ---------------- V6: retention / compaction ----------------

  async pruneSnapshots(decision_id: string, keep_last_n: number): Promise<{ deleted: number }> {
    const keep = Math.max(0, Math.floor(keep_last_n));
    if (keep === 0) {
      const info = this.db
        .prepare(`DELETE FROM decision_snapshots WHERE decision_id = ?`)
        .run(decision_id);
      return { deleted: info.changes };
    }

    const info = this.db
      .prepare(
        `
        DELETE FROM decision_snapshots
        WHERE decision_id = ?
          AND up_to_seq NOT IN (
            SELECT up_to_seq
            FROM decision_snapshots
            WHERE decision_id = ?
            ORDER BY up_to_seq DESC
            LIMIT ?
          )
      `
      )
      .run(decision_id, decision_id, keep);

    return { deleted: info.changes };
  }

  async pruneEventsUpToSeq(decision_id: string, up_to_seq: number): Promise<{ deleted: number }> {
    const info = this.db
      .prepare(
        `
        DELETE FROM decision_events
        WHERE decision_id = ?
          AND seq <= ?
      `
      )
      .run(decision_id, up_to_seq);

    return { deleted: info.changes };
  }
}

