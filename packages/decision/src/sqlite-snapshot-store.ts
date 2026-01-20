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
        decision_id           TEXT NOT NULL,
        up_to_seq             INTEGER NOT NULL,
        decision_json         TEXT NOT NULL,
        created_at            TEXT NOT NULL,

        checkpoint_hash       TEXT,
        root_hash             TEXT,
        state_hash            TEXT,
        provenance_tail_hash  TEXT,

        PRIMARY KEY (decision_id, up_to_seq)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_latest
        ON decision_snapshots(decision_id, up_to_seq DESC);

      -- Back-compat: add columns if table existed before
      ALTER TABLE decision_snapshots ADD COLUMN checkpoint_hash TEXT;
      ALTER TABLE decision_snapshots ADD COLUMN root_hash TEXT;
      ALTER TABLE decision_snapshots ADD COLUMN state_hash TEXT;
      ALTER TABLE decision_snapshots ADD COLUMN provenance_tail_hash TEXT;
    `);
  }

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT decision_id, up_to_seq, decision_json, created_at,
               checkpoint_hash, root_hash, state_hash, provenance_tail_hash
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
          checkpoint_hash: string | null;
          root_hash: string | null;
          state_hash: string | null;
          provenance_tail_hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      up_to_seq: row.up_to_seq,
      decision: JSON.parse(row.decision_json),
      created_at: row.created_at,

      checkpoint_hash: row.checkpoint_hash ?? null,
      root_hash: row.root_hash ?? null,
      state_hash: row.state_hash ?? null,
      provenance_tail_hash: row.provenance_tail_hash ?? null,
    };
  }

  // ✅ V7
  async getSnapshotAtOrBefore(decision_id: string, up_to_seq: number): Promise<DecisionSnapshot | null> {
    const row = this.db
      .prepare(
        `
        SELECT decision_id, up_to_seq, decision_json, created_at,
               checkpoint_hash, root_hash, state_hash, provenance_tail_hash
        FROM decision_snapshots
        WHERE decision_id = ? AND up_to_seq <= ?
        ORDER BY up_to_seq DESC
        LIMIT 1
        `
      )
      .get(decision_id, up_to_seq) as
      | {
          decision_id: string;
          up_to_seq: number;
          decision_json: string;
          created_at: string;
          checkpoint_hash: string | null;
          root_hash: string | null;
          state_hash: string | null;
          provenance_tail_hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      up_to_seq: row.up_to_seq,
      decision: JSON.parse(row.decision_json),
      created_at: row.created_at,

      checkpoint_hash: row.checkpoint_hash ?? null,
      root_hash: row.root_hash ?? null,
      state_hash: row.state_hash ?? null,
      provenance_tail_hash: row.provenance_tail_hash ?? null,
    };
  }

  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
        this.db
      .prepare(
        `
        INSERT OR REPLACE INTO decision_snapshots(
          decision_id, up_to_seq, decision_json, created_at,
          checkpoint_hash, root_hash, state_hash, provenance_tail_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        snapshot.decision_id,
        snapshot.up_to_seq,
        JSON.stringify(snapshot.decision),
        snapshot.created_at,

        snapshot.checkpoint_hash ?? null,
        snapshot.root_hash ?? null,
        snapshot.state_hash ?? null,
        snapshot.provenance_tail_hash ?? null
      );
  }
}

