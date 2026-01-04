// packages/decision/src/sqlite-store.ts
import Database from "better-sqlite3";
import crypto from "node:crypto";

import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { AppendEventInput, DecisionEventRecord, DecisionStore, MerkleProof } from "./store.js";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

import { buildMerkleProofFromLeaves } from "./merkle-proof.js";

import type { AppendAnchorInput, DecisionAnchorRecord, DecisionAnchorStore } from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

// ---------------------------------
// Feature 17: hash-chain utilities
// ---------------------------------
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const norm = (v: any): any => {
    if (v === null) return null;
    if (typeof v !== "object") return v;

    if (seen.has(v)) return "[Circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map(norm);

    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };

  return JSON.stringify(norm(value));
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeEventHash(input: {
  decision_id: string;
  seq: number;
  at: string;
  idempotency_key?: string | null;
  event: DecisionEvent;
  prev_hash?: string | null;
}): string {
  const payload = stableStringify({
    decision_id: input.decision_id,
    seq: input.seq,
    at: input.at,
    idempotency_key: input.idempotency_key ?? null,
    event: input.event,
    prev_hash: input.prev_hash ?? null,
  });

  return sha256Hex(payload);
}

// ---------------------------------
// Feature 21: Merkle root of hashes
// - If any leaf hash is missing -> null (cannot compute)
// ---------------------------------
function merkleRootHex(leaves: Array<string | null>): string | null {
  if (leaves.length === 0) return null;
  if (leaves.some((h) => !h)) return null;

  let level = leaves as string[];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(`${left}:${right}`));
    }
    level = next;
  }
  return level[0] ?? null;
}

// ---------------------------------
// Store
// ---------------------------------
export class SqliteDecisionStore
  implements DecisionStore, DecisionSnapshotStore, DecisionAnchorStore
{
  private db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init() {
    // decisions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        decision_json TEXT NOT NULL
      );
    `);

    // events (append-only)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_events (
        decision_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        idempotency_key TEXT,
        prev_hash TEXT,
        hash TEXT,
        PRIMARY KEY (decision_id, seq)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_events_decision_seq
      ON decision_events (decision_id, seq);
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_events_idempotency_unique
      ON decision_events (decision_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    // snapshots
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_snapshots (
        decision_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        at TEXT NOT NULL,
        up_to_seq INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        checkpoint_hash TEXT,
        root_hash TEXT,
        PRIMARY KEY (decision_id, snapshot_id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_snapshots_decision_seq
      ON decision_snapshots (decision_id, up_to_seq);
    `);

    // anchors (append-only logically, but retention will delete older rows)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_anchors (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        snapshot_up_to_seq INTEGER NOT NULL,
        checkpoint_hash TEXT,
        root_hash TEXT,
        prev_hash TEXT,
        hash TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_anchors_decision_seq
      ON decision_anchors (decision_id, snapshot_up_to_seq);
    `);

    // ✅ Feature 27: prevent duplicate anchor per snapshot
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_anchors_unique_snapshot
      ON decision_anchors (decision_id, snapshot_up_to_seq);
    `);

    // ---- migrations for older DBs ----
    this.ensureColumn("decision_events", "prev_hash", "TEXT");
    this.ensureColumn("decision_events", "hash", "TEXT");
    this.ensureColumn("decision_snapshots", "checkpoint_hash", "TEXT");
    this.ensureColumn("decision_snapshots", "root_hash", "TEXT");

    this.ensureColumn("decision_anchors", "checkpoint_hash", "TEXT");
    this.ensureColumn("decision_anchors", "root_hash", "TEXT");
    this.ensureColumn("decision_anchors", "prev_hash", "TEXT");
    this.ensureColumn("decision_anchors", "hash", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
    const has = rows.some((r) => r.name === column);
    if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }

  // -----------------------------
  // Optional transactional helper (async + nested)
  // -----------------------------
  private _sp = 0;

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const inTx = (this.db as any).inTransaction === true;

    if (!inTx) {
      this.db.exec("BEGIN");
      try {
        const out = await fn();
        this.db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    }

    const sp = `sp_${++this._sp}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = await fn();
      this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {}
      throw e;
    }
  }

  // -----------------------------
  // decisions
  // -----------------------------
  async createDecision(decision: Decision): Promise<void> {
    const root_id = decision.parent_decision_id ?? decision.decision_id;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO decisions (decision_id, root_id, version, decision_json)
         VALUES (?, ?, ?, ?);`
      )
      .run(decision.decision_id, root_id, decision.version ?? 1, JSON.stringify(decision));
  }

  async putDecision(decision: Decision): Promise<void> {
    const root_id = decision.parent_decision_id ?? decision.decision_id;

    this.db
      .prepare(
        `INSERT INTO decisions (decision_id, root_id, version, decision_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET
           root_id=excluded.root_id,
           version=excluded.version,
           decision_json=excluded.decision_json;`
      )
      .run(decision.decision_id, root_id, decision.version ?? 1, JSON.stringify(decision));
  }

  async getDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT decision_json FROM decisions WHERE decision_id=?;`)
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT root_id FROM decisions WHERE decision_id=?;`)
      .get(decision_id) as { root_id: string } | undefined;

    const root_id = row?.root_id ?? decision_id;
    return this.getDecision(root_id);
  }

  async getCurrentVersion(decision_id: string): Promise<number | null> {
    const row = this.db
      .prepare(`SELECT version FROM decisions WHERE decision_id=?;`)
      .get(decision_id) as { version: number } | undefined;

    return row ? row.version : null;
  }

  // -----------------------------
  // Feature 19 helper: hash at seq
  // -----------------------------
  private getEventHashAtSeq(decision_id: string, seq: number): string | null {
    const row = this.db
      .prepare(`SELECT hash FROM decision_events WHERE decision_id=? AND seq=? LIMIT 1;`)
      .get(decision_id, seq) as { hash: string | null } | undefined;

    return row?.hash ?? null;
  }

  // -----------------------------
  // Feature 21 helper: hashes [1..up_to_seq] with gap detection
  // -----------------------------
  private listEventHashesUpToSeq(decision_id: string, up_to_seq: number): Array<string | null> {
    if (up_to_seq <= 0) return [];

    const rows = this.db
      .prepare(
        `SELECT seq, hash
         FROM decision_events
         WHERE decision_id=? AND seq BETWEEN 1 AND ?
         ORDER BY seq ASC;`
      )
      .all(decision_id, up_to_seq) as Array<{ seq: number; hash: string | null }>;

    const out: Array<string | null> = new Array(up_to_seq).fill(null);
    for (const r of rows) out[r.seq - 1] = r.hash ?? null;
    return out;
  }

  // -----------------------------
  // snapshots
  // -----------------------------
  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
    const snapAny = snapshot as any;

    const decision_id: string = snapAny.decision_id;
    const up_to_seq: number = snapAny.up_to_seq;

    const at: string =
      typeof snapAny.created_at === "string" && snapAny.created_at.length
        ? snapAny.created_at
        : new Date().toISOString();

    const snapshot_id: string =
      typeof snapAny.snapshot_id === "string" && snapAny.snapshot_id.trim().length
        ? snapAny.snapshot_id
        : `${decision_id}@${up_to_seq}`;

    const checkpoint_hash: string | null =
      typeof snapAny.checkpoint_hash === "string"
        ? snapAny.checkpoint_hash
        : up_to_seq > 0
          ? this.getEventHashAtSeq(decision_id, up_to_seq)
          : null;

    const root_hash: string | null =
      typeof snapAny.root_hash === "string"
        ? snapAny.root_hash
        : up_to_seq > 0
          ? merkleRootHex(this.listEventHashesUpToSeq(decision_id, up_to_seq))
          : null;

    const snapshot_json = JSON.stringify({
      ...snapAny,
      snapshot_id,
      created_at: at,
      checkpoint_hash,
      root_hash,
    });

    this.db
      .prepare(
        `INSERT INTO decision_snapshots
           (decision_id, snapshot_id, at, up_to_seq, snapshot_json, checkpoint_hash, root_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(decision_id, snapshot_id) DO UPDATE SET
           at=excluded.at,
           up_to_seq=excluded.up_to_seq,
           snapshot_json=excluded.snapshot_json,
           checkpoint_hash=excluded.checkpoint_hash,
           root_hash=excluded.root_hash;`
      )
      .run(decision_id, snapshot_id, at, up_to_seq, snapshot_json, checkpoint_hash, root_hash);
  }

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    const row = this.db
      .prepare(
        `SELECT snapshot_json
         FROM decision_snapshots
         WHERE decision_id=?
         ORDER BY up_to_seq DESC
         LIMIT 1;`
      )
      .get(decision_id) as { snapshot_json: string } | undefined;

    return row ? (JSON.parse(row.snapshot_json) as DecisionSnapshot) : null;
  }

  async pruneSnapshots(decision_id: string, keep_last_n: number): Promise<{ deleted: number }> {
    const n = Math.max(0, Math.floor(keep_last_n));

    if (n === 0) {
      const info = this.db.prepare(`DELETE FROM decision_snapshots WHERE decision_id=?;`).run(decision_id);
      return { deleted: Number(info.changes ?? 0) };
    }

    const info = this.db
      .prepare(
        `
        DELETE FROM decision_snapshots
        WHERE decision_id=?
          AND snapshot_id NOT IN (
            SELECT snapshot_id
            FROM decision_snapshots
            WHERE decision_id=?
            ORDER BY up_to_seq DESC
            LIMIT ?
          );
        `
      )
      .run(decision_id, decision_id, n);

    return { deleted: Number(info.changes ?? 0) };
  }

  // -----------------------------
  // events
  // -----------------------------
  async getLastEvent(decision_id: string): Promise<DecisionEventRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=?
         ORDER BY seq DESC
         LIMIT 1;`
      )
      .get(decision_id) as
      | {
          decision_id: string;
          seq: number;
          at: string;
          event_json: string;
          idempotency_key: string | null;
          prev_hash: string | null;
          hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event_json) as DecisionEvent,
      idempotency_key: row.idempotency_key ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  async appendEvent(decision_id: string, input: AppendEventInput): Promise<DecisionEventRecord> {
    return this.runInTransaction(async () => {
      const event: DecisionEvent = input.event;
      const at = input.at;
      const idempotency_key = input.idempotency_key ?? null;

      if (idempotency_key && this.findEventByIdempotencyKey) {
        const existing = await this.findEventByIdempotencyKey(decision_id, idempotency_key);
        if (existing) return existing;
      }

      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM decision_events WHERE decision_id=?;`)
        .get(decision_id) as { max_seq: number };

      const seq = (row?.max_seq ?? 0) + 1;

      const last = await this.getLastEvent(decision_id);
      const prev_hash = last?.hash ?? null;

      const hash = computeEventHash({
        decision_id,
        seq,
        at,
        idempotency_key,
        event,
        prev_hash,
      });

      try {
        this.db
          .prepare(
            `INSERT INTO decision_events
              (decision_id, seq, at, event_json, idempotency_key, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?);`
          )
          .run(decision_id, seq, at, JSON.stringify(event), idempotency_key, prev_hash, hash);
      } catch (e: any) {
        if (idempotency_key && String(e?.message ?? "").includes("UNIQUE")) {
          const existing2 = await this.findEventByIdempotencyKey(decision_id, idempotency_key);
          if (existing2) return existing2;
        }
        throw e;
      }

      return { decision_id, seq, at, event, idempotency_key, prev_hash, hash };
    });
  }

  async listEvents(decision_id: string): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=?
         ORDER BY seq ASC;`
      )
      .all(decision_id) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
      prev_hash: string | null;
      hash: string | null;
    }>;

    return rows.map((r) => ({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.event_json) as DecisionEvent,
      idempotency_key: r.idempotency_key ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    }));
  }

  async listEventsFrom(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=? AND seq > ?
         ORDER BY seq ASC;`
      )
      .all(decision_id, after_seq) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
      prev_hash: string | null;
      hash: string | null;
    }>;

    return rows.map((r) => ({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.event_json) as DecisionEvent,
      idempotency_key: r.idempotency_key ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    }));
  }

  async listEventsTail(decision_id: string, limit: number): Promise<DecisionEventRecord[]> {
    if (limit <= 0) return [];

    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=?
         ORDER BY seq DESC
         LIMIT ?;`
      )
      .all(decision_id, limit) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
      prev_hash: string | null;
      hash: string | null;
    }>;

    return rows
      .map((r) => ({
        decision_id: r.decision_id,
        seq: r.seq,
        at: r.at,
        event: JSON.parse(r.event_json) as DecisionEvent,
        idempotency_key: r.idempotency_key ?? null,
        prev_hash: r.prev_hash ?? null,
        hash: r.hash ?? null,
      }))
      .reverse();
  }

  async findEventByIdempotencyKey(decision_id: string, idempotency_key: string): Promise<DecisionEventRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=? AND idempotency_key=?
         ORDER BY seq ASC
         LIMIT 1;`
      )
      .get(decision_id, idempotency_key) as
      | {
          decision_id: string;
          seq: number;
          at: string;
          event_json: string;
          idempotency_key: string | null;
          prev_hash: string | null;
          hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event_json) as DecisionEvent,
      idempotency_key: row.idempotency_key ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  async pruneEventsUpToSeq(decision_id: string, up_to_seq: number): Promise<{ deleted: number }> {
    const info = this.db
      .prepare(`DELETE FROM decision_events WHERE decision_id=? AND seq <= ?;`)
      .run(decision_id, up_to_seq);
    return { deleted: Number(info.changes ?? 0) };
  }

  async getEventBySeq(decision_id: string, seq: number): Promise<DecisionEventRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=? AND seq=?
         LIMIT 1;`
      )
      .get(decision_id, seq) as
      | {
          decision_id: string;
          seq: number;
          at: string;
          event_json: string;
          idempotency_key: string | null;
          prev_hash: string | null;
          hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: JSON.parse(row.event_json) as DecisionEvent,
      idempotency_key: row.idempotency_key ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  // -----------------------------
  // Feature 23 helper: complete hashes 1..up_to_seq
  // -----------------------------
  private listCompleteEventHashesUpToSeq(decision_id: string, up_to_seq: number): string[] | null {
    if (up_to_seq <= 0) return [];

    const rows = this.db
      .prepare(
        `SELECT seq, hash
         FROM decision_events
         WHERE decision_id=? AND seq <= ?
         ORDER BY seq ASC;`
      )
      .all(decision_id, up_to_seq) as Array<{ seq: number; hash: string | null }>;

    if (rows.length !== up_to_seq) return null;

    const out: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const expectedSeq = i + 1;
      const r = rows[i]!;
      if (r.seq !== expectedSeq) return null;
      if (!r.hash) return null;
      out.push(r.hash);
    }
    return out;
  }

  async getMerkleProof(decision_id: string, seq: number, up_to_seq: number): Promise<MerkleProof | null> {
    const upto = Math.floor(up_to_seq);
    const s = Math.floor(seq);

    if (upto <= 0) return null;
    if (s <= 0 || s > upto) return null;

    const leaves = this.listCompleteEventHashesUpToSeq(decision_id, upto);
    if (!leaves) return null;

    return buildMerkleProofFromLeaves({
      decision_id,
      up_to_seq: upto,
      seq: s,
      leaves,
    });
  }

  // -----------------------------
  // Anchors (Feature 25/26/27)
  // -----------------------------
  async getLastAnchor(): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, prev_hash, hash
         FROM decision_anchors
         ORDER BY seq DESC
         LIMIT 1;`
      )
      .get() as
      | {
          seq: number;
          at: string;
          decision_id: string;
          snapshot_up_to_seq: number;
          checkpoint_hash: string | null;
          root_hash: string | null;
          prev_hash: string | null;
          hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      seq: row.seq,
      at: row.at,
      decision_id: row.decision_id,
      snapshot_up_to_seq: row.snapshot_up_to_seq,
      checkpoint_hash: row.checkpoint_hash ?? null,
      root_hash: row.root_hash ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  // ✅ Feature 27 canonical helper
  async getAnchorForSnapshot(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, prev_hash, hash
         FROM decision_anchors
         WHERE decision_id=? AND snapshot_up_to_seq=?
         LIMIT 1;`
      )
      .get(decision_id, snapshot_up_to_seq) as
      | {
          seq: number;
          at: string;
          decision_id: string;
          snapshot_up_to_seq: number;
          checkpoint_hash: string | null;
          root_hash: string | null;
          prev_hash: string | null;
          hash: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      seq: row.seq,
      at: row.at,
      decision_id: row.decision_id,
      snapshot_up_to_seq: row.snapshot_up_to_seq,
      checkpoint_hash: row.checkpoint_hash ?? null,
      root_hash: row.root_hash ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  // keep your old name too (optional compatibility)
  async findAnchorByCheckpoint(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null> {
    return this.getAnchorForSnapshot(decision_id, snapshot_up_to_seq);
  }

  async appendAnchor(input: AppendAnchorInput): Promise<DecisionAnchorRecord> {
    return this.runInTransaction(async () => {
      const at = input.at;
      const decision_id = input.decision_id;
      const snapshot_up_to_seq = input.snapshot_up_to_seq;

      // ✅ Feature 27: idempotent
      const existing = await this.getAnchorForSnapshot(decision_id, snapshot_up_to_seq);
      if (existing) return existing;

      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM decision_anchors;`)
        .get() as { max_seq: number };

      const seq = (row?.max_seq ?? 0) + 1;

      const last = await this.getLastAnchor();
      const prev_hash = last?.hash ?? null;

      const hash = computeAnchorHash({
        seq,
        at,
        decision_id,
        snapshot_up_to_seq,
        checkpoint_hash: input.checkpoint_hash ?? null,
        root_hash: input.root_hash ?? null,
        prev_hash,
      });

      try {
        this.db
          .prepare(
            `INSERT INTO decision_anchors
              (seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
          )
          .run(
            seq,
            at,
            decision_id,
            snapshot_up_to_seq,
            input.checkpoint_hash ?? null,
            input.root_hash ?? null,
            prev_hash,
            hash
          );
      } catch (e: any) {
        // UNIQUE (decision_id, snapshot_up_to_seq) race → read and return
        if (String(e?.message ?? "").includes("UNIQUE")) {
          const existing2 = await this.getAnchorForSnapshot(decision_id, snapshot_up_to_seq);
          if (existing2) return existing2;
        }
        throw e;
      }

      return {
        seq,
        at,
        decision_id,
        snapshot_up_to_seq,
        checkpoint_hash: input.checkpoint_hash ?? null,
        root_hash: input.root_hash ?? null,
        prev_hash,
        hash,
      };
    });
  }

  async listAnchors(): Promise<DecisionAnchorRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, prev_hash, hash
         FROM decision_anchors
         ORDER BY seq ASC;`
      )
      .all() as Array<{
      seq: number;
      at: string;
      decision_id: string;
      snapshot_up_to_seq: number;
      checkpoint_hash: string | null;
      root_hash: string | null;
      prev_hash: string | null;
      hash: string | null;
    }>;

    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      decision_id: r.decision_id,
      snapshot_up_to_seq: r.snapshot_up_to_seq,
      checkpoint_hash: r.checkpoint_hash ?? null,
      root_hash: r.root_hash ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    }));
  }

  // Re-chain remaining anchors after retention deletes old ones
  private rechainAnchors(): void {
    const rows = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash
         FROM decision_anchors
         ORDER BY seq ASC;`
      )
      .all() as Array<{
      seq: number;
      at: string;
      decision_id: string;
      snapshot_up_to_seq: number;
      checkpoint_hash: string | null;
      root_hash: string | null;
    }>;

    let prev_hash: string | null = null;

    const upd = this.db.prepare(
      `UPDATE decision_anchors SET prev_hash=?, hash=? WHERE seq=?;`
    );

    for (const r of rows) {
      const hash = computeAnchorHash({
        seq: r.seq,
        at: r.at,
        decision_id: r.decision_id,
        snapshot_up_to_seq: r.snapshot_up_to_seq,
        checkpoint_hash: r.checkpoint_hash ?? null,
        root_hash: r.root_hash ?? null,
        prev_hash,
      });

      upd.run(prev_hash, hash, r.seq);
      prev_hash = hash;
    }
  }

  // ✅ keep ONE pruneAnchors only (you previously had duplicates)
  async pruneAnchors(keep_last_n: number): Promise<{ deleted: number; remaining: number }> {
    return this.runInTransaction(async () => {
      const n = Math.max(0, Math.floor(keep_last_n));

      const beforeRow = this.db.prepare(`SELECT COUNT(*) AS c FROM decision_anchors;`).get() as { c: number };
      const before = Number(beforeRow?.c ?? 0);

      if (n === 0) {
        const info = this.db.prepare(`DELETE FROM decision_anchors;`).run();
        return { deleted: Number(info.changes ?? 0), remaining: 0 };
      }

      const info = this.db
        .prepare(
          `
          DELETE FROM decision_anchors
          WHERE seq NOT IN (
            SELECT seq
            FROM decision_anchors
            ORDER BY seq DESC
            LIMIT ?
          );
          `
        )
        .run(n);

      // critical: re-chain remaining anchors so verification works
      this.rechainAnchors();

      const afterRow = this.db.prepare(`SELECT COUNT(*) AS c FROM decision_anchors;`).get() as { c: number };
      const after = Number(afterRow?.c ?? 0);

      return { deleted: before - after, remaining: after };
    });
  }
}

