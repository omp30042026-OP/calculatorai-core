import Database from "better-sqlite3";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

type ColInfo = { name: string };

export class SqliteDecisionSnapshotStore implements DecisionSnapshotStore {
  private db: Database.Database;
  private cols: Set<string> = new Set();

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
    this.refreshColumns();
  }

  private refreshColumns() {
    try {
      const cols = this.db
        .prepare(`PRAGMA table_info(decision_snapshots)`)
        .all() as ColInfo[];
      this.cols = new Set(cols.map((c) => c.name));
    } catch {
      this.cols = new Set();
    }
  }

  private hasCol(name: string): boolean {
    return this.cols.has(name);
  }

  private migrate() {
    const safeExec = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (msg.includes("duplicate column")) return;
        if (msg.includes("no such table")) return;
        throw e;
      }
    };

    // Create table if missing (new installs)
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
    `);

    // Back-compat columns (old schemas)
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN snapshot_id TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN at TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN snapshot_json TEXT`);

    // Ensure new columns exist on old tables too
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN decision_json TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN created_at TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN checkpoint_hash TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN root_hash TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN state_hash TEXT`);
    safeExec(`ALTER TABLE decision_snapshots ADD COLUMN provenance_tail_hash TEXT`);

    // Best-effort: fill created_at if null
    safeExec(`
      UPDATE decision_snapshots
      SET created_at = COALESCE(created_at, at, datetime('now'))
      WHERE created_at IS NULL
    `);

    safeExec(`CREATE TABLE IF NOT EXISTS _schema_version (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
    safeExec(`INSERT OR IGNORE INTO _schema_version(k,v) VALUES ('decision_snapshots', 1)`);
    // If an older schema used `decision` column, copy it into decision_json
    try {
      const cols = this.db
        .prepare(`PRAGMA table_info(decision_snapshots)`)
        .all() as Array<{ name: string }>;
      const has = (name: string) => cols.some((c) => c.name === name);

      if (has("decision") && has("decision_json")) {
        this.db.exec(`
          UPDATE decision_snapshots
          SET decision_json = decision
          WHERE (decision_json IS NULL OR decision_json = '')
        `);
      }
    } catch {
      // best-effort
    }
  }

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    // IMPORTANT: only reference columns that exist (avoid "no such column: at")
    const createdAtExpr = this.hasCol("created_at")
      ? (this.hasCol("at") ? `COALESCE(created_at, at)` : `created_at`)
      : (this.hasCol("at") ? `at` : `datetime('now')`);

    const decisionExpr = this.hasCol("decision_json")
      ? (this.hasCol("snapshot_json") ? `COALESCE(decision_json, snapshot_json)` : `decision_json`)
      : (this.hasCol("snapshot_json") ? `snapshot_json` : `NULL`);

    const row = this.db
      .prepare(
        `
        SELECT decision_id, up_to_seq,
               ${decisionExpr} AS decision_json,
               ${createdAtExpr} AS created_at,
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
          decision_json: string | null;
          created_at: string;
          checkpoint_hash: string | null;
          root_hash: string | null;
          state_hash: string | null;
          provenance_tail_hash: string | null;
        }
      | undefined;

    if (!row) return null;
    if (!row.decision_json) return null;

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

  async getSnapshotAtOrBefore(decision_id: string, up_to_seq: number): Promise<DecisionSnapshot | null> {
    const createdAtExpr = this.hasCol("created_at")
      ? (this.hasCol("at") ? `COALESCE(created_at, at)` : `created_at`)
      : (this.hasCol("at") ? `at` : `datetime('now')`);

    const decisionExpr = this.hasCol("decision_json")
      ? (this.hasCol("snapshot_json") ? `COALESCE(decision_json, snapshot_json)` : `decision_json`)
      : (this.hasCol("snapshot_json") ? `snapshot_json` : `NULL`);

    const row = this.db
      .prepare(
        `
        SELECT decision_id, up_to_seq,
               ${decisionExpr} AS decision_json,
               ${createdAtExpr} AS created_at,
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
          decision_json: string | null;
          created_at: string;
          checkpoint_hash: string | null;
          root_hash: string | null;
          state_hash: string | null;
          provenance_tail_hash: string | null;
        }
      | undefined;

    if (!row) return null;
    if (!row.decision_json) return null;

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
    // refreshColumns here in case DB was migrated by another process
    this.refreshColumns();

    const decisionJson = JSON.stringify(snapshot.decision);

    // Build dynamic INSERT only using existing columns
    const cols: string[] = [];
    const vals: any[] = [];

    const push = (col: string, val: any) => {
      if (this.hasCol(col)) {
        cols.push(col);
        vals.push(val);
      }
    };

    push("decision_id", snapshot.decision_id);
    push("up_to_seq", snapshot.up_to_seq);

    // old schema fields
    push("snapshot_id", String(snapshot.up_to_seq));      // stable
    push("at", snapshot.created_at);
    push("snapshot_json", decisionJson);

    // new schema fields
    push("decision_json", decisionJson);
    push("created_at", snapshot.created_at);

    // hashes
    push("checkpoint_hash", snapshot.checkpoint_hash ?? null);
    push("root_hash", snapshot.root_hash ?? null);
    push("state_hash", snapshot.state_hash ?? null);
    push("provenance_tail_hash", snapshot.provenance_tail_hash ?? null);

    const placeholders = cols.map(() => "?").join(", ");

    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO decision_snapshots(${cols.join(", ")})
        VALUES (${placeholders})
        `
      )
      .run(...vals);
  }
}

