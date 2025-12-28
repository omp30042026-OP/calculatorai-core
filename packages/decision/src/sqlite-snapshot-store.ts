// packages/decision/src/sqlite-snapshot-store.ts
import Database from "better-sqlite3";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

export class SqliteDecisionSnapshotStore implements DecisionSnapshotStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_snapshots (
        decision_id   TEXT NOT NULL,
        up_to_seq     INTEGER NOT NULL,
        decision_json TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (decision_id, up_to_seq)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_latest
        ON decision_snapshots(decision_id, up_to_seq DESC);
    `);
  }

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT decision_id, up_to_seq, decision_json, created_at
        FROM decision_snapshots
        WHERE decision_id = ?
        ORDER BY up_to_seq DESC
        LIMIT 1
        `
      )
      .get(decision_id) as
      | {
          decision_id: string;
          up_to_seq: number;
          decision_json: string;
          created_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      up_to_seq: row.up_to_seq,
      decision: JSON.parse(row.decision_json),
      created_at: row.created_at,
    };
  }

  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO decision_snapshots(
          decision_id,
          up_to_seq,
          decision_json,
          created_at
        )
        VALUES (?, ?, ?, ?)
        `
      )
      .run(
        snapshot.decision_id,
        snapshot.up_to_seq,
        JSON.stringify(snapshot.decision),
        snapshot.created_at
      );
  }
}
