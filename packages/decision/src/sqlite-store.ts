// packages/decision/src/sqlite-store.ts
import Database from "better-sqlite3";
import crypto from "node:crypto";

import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type {
  AppendEventInput,
  DecisionEventRecord,
  DecisionStore,
  MerkleProof,
} from "./store.js";
import type { DecisionSnapshot, DecisionSnapshotStore } from "./snapshots.js";

import { buildMerkleProofFromLeaves } from "./merkle-proof.js";

import type {
  AppendAnchorInput,
  DecisionAnchorRecord,
  DecisionAnchorStore,
} from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

import type { LedgerEntry, LedgerEntryType, LedgerQuery, LedgerVerifyReport} from "./ledger.js";
import { computeLedgerEntryHash, signLedgerHash,verifyLedgerEntries } from "./ledger.js";
import type { LedgerSigner, LedgerVerifier } from "./ledger-signing.js";
import type { VerifyLedgerOptions } from "./ledger-store.js";


import { ensureEnterpriseTables } from "./enterprise-schema.js";


import type { DecisionEdgeDirection, DecisionEdgeRecord, DecisionRoleRecord } from "./store.js";


// ✅ Feature 15: PLS record (auditable)
export type PlsShieldRecord = {
  decision_id: string;
  event_seq: number;
  event_type: string;

  owner_id: string;
  approver_id: string;

  signer_state_hash: string;

  payload_json: string | null;
  shield_hash: string;

  created_at: string;
};


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

// ---------------------------------
// Feature 14: Decision Provenance Graph (DAG) - edge input
// ---------------------------------
export type DecisionEdgeInput = {
  from_decision_id: string;
  to_decision_id: string;
  relation: string;
  via_event_seq: number;
  meta?: unknown;
  created_at: string;
};

// ---------------------------------
// Feature 14: Decision Provenance Graph (DAG) - edge record (read)
// ---------------------------------
type SqliteDecisionEdgeRecord = {
  from_decision_id: string;
  to_decision_id: string;
  relation: string;
  via_event_seq: number;
  edge_hash: string;
  meta_json: string | null;
  created_at: string;
};








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
// Feature 32: decision state hash (snapshot decision JSON)
// ---------------------------------
function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}



// ✅ Feature 15: PLS shield hash (canonical)
function computePlsShieldHash(payload: {
  decision_id: string;
  event_seq: number;
  event_type: string;
  owner_id: string;
  approver_id: string;
  signer_state_hash: string;
  payload_json: string | null;
  created_at: string;
}): string {
  return sha256Hex(
    stableStringify({
      kind: "PLS_SHIELD_V1",
      decision_id: payload.decision_id,
      event_seq: payload.event_seq,
      event_type: payload.event_type,
      owner_id: payload.owner_id,
      approver_id: payload.approver_id,
      signer_state_hash: payload.signer_state_hash,
      payload_json: payload.payload_json,
      created_at: payload.created_at,
    })
  );
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
    ensureEnterpriseTables(this.db);
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
        state_hash TEXT,
        PRIMARY KEY (decision_id, snapshot_id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_snapshots_decision_seq
      ON decision_snapshots (decision_id, up_to_seq);
    `);

    // anchors
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_anchors (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        snapshot_up_to_seq INTEGER NOT NULL,
        checkpoint_hash TEXT,
        root_hash TEXT,
        state_hash TEXT,
        prev_hash TEXT,
        hash TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_anchors_decision_seq
      ON decision_anchors (decision_id, snapshot_up_to_seq);
    `);

    // prevent duplicate anchor per snapshot
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_anchors_unique_snapshot
      ON decision_anchors (decision_id, snapshot_up_to_seq);
    `);

    // ---- migrations for older DBs ----
    this.ensureColumn("decision_events", "prev_hash", "TEXT");
    this.ensureColumn("decision_events", "hash", "TEXT");

    this.ensureColumn("decision_snapshots", "checkpoint_hash", "TEXT");
    this.ensureColumn("decision_snapshots", "root_hash", "TEXT");
    this.ensureColumn("decision_snapshots", "state_hash", "TEXT");

    this.ensureColumn("decision_anchors", "checkpoint_hash", "TEXT");
    this.ensureColumn("decision_anchors", "root_hash", "TEXT");
    this.ensureColumn("decision_anchors", "state_hash", "TEXT");
    this.ensureColumn("decision_anchors", "prev_hash", "TEXT");
    this.ensureColumn("decision_anchors", "hash", "TEXT");

    // ✅ CRITICAL: backfill hash-chains for existing rows (old DBs)
    this.backfillAllEventHashChains();


    // ledger (global append-only)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_ledger (
          seq INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          tenant_id TEXT,
          type TEXT NOT NULL,
          decision_id TEXT,
          event_seq INTEGER,
          snapshot_up_to_seq INTEGER,
          anchor_seq INTEGER,
          payload_json TEXT,
          prev_hash TEXT,
          hash TEXT NOT NULL,

          sig_alg TEXT,
          key_id TEXT,
          sig TEXT
        );
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_enterprise_ledger_decision
        ON enterprise_ledger (decision_id, seq);
      `);

      // migrations for older DBs
      this.ensureColumn("enterprise_ledger", "sig_alg", "TEXT");
      this.ensureColumn("enterprise_ledger", "key_id", "TEXT");
      this.ensureColumn("enterprise_ledger", "sig", "TEXT");


      

  }

  private ensureColumn(table: string, column: string, type: string) {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table});`)
      .all() as Array<{ name: string }>;
    const has = rows.some((r) => r.name === column);
    if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }

  // -----------------------------
  // ✅ Feature 9/17: Backfill event hash-chain for existing DB rows
  // Why: if older events were inserted with hash=null, verification can never pass.
  // -----------------------------
  private backfillAllEventHashChains(): void {
    // quick check: if there are no missing hashes, do nothing
    const missingRow = this.db
      .prepare(
        `SELECT 1 AS x
        FROM decision_events
        WHERE (hash IS NULL OR hash = '')
            OR (seq > 1 AND (prev_hash IS NULL OR prev_hash = ''))
        LIMIT 1;`
      )
      .get() as { x: 1 } | undefined;

    if (!missingRow) return;

    this.db.exec("BEGIN");
    try {
      const ids = this.db
        .prepare(
          `SELECT DISTINCT decision_id
           FROM decision_events
           ORDER BY decision_id ASC;`
        )
        .all() as Array<{ decision_id: string }>;

      for (const r of ids) {
        this.backfillEventChainForDecision(r.decision_id);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  private backfillEventChainForDecision(decision_id: string): void {
    const rows = this.db
      .prepare(
        `SELECT seq, at, event_json, idempotency_key
         FROM decision_events
         WHERE decision_id=?
         ORDER BY seq ASC;`
      )
      .all(decision_id) as Array<{
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
    }>;

    if (rows.length === 0) return;

    const upd = this.db.prepare(
      `UPDATE decision_events SET prev_hash=?, hash=? WHERE decision_id=? AND seq=?;`
    );

    let prev_hash: string | null = null;

    for (const row of rows) {
      const event = JSON.parse(row.event_json) as DecisionEvent;

      const hash = computeEventHash({
        decision_id,
        seq: row.seq,
        at: row.at,
        idempotency_key: row.idempotency_key ?? null,
        event,
        prev_hash,
      });

      upd.run(prev_hash, hash, decision_id, row.seq);
      prev_hash = hash;
    }
  }

  // ---------------------------------
  // ✅ Feature 15: PLS reads (audit-grade)
  // ---------------------------------
  async getLiabilityShield(decision_id: string, event_seq: number): Promise<PlsShieldRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id,event_seq,event_type,owner_id,approver_id,signer_state_hash,payload_json,shield_hash,created_at
        FROM pls_shields
        WHERE decision_id=? AND event_seq=?
        LIMIT 1;`
      )
      .get(decision_id, Number(event_seq)) as any;

    if (!row) return null;

    return {
      decision_id: String(row.decision_id),
      event_seq: Number(row.event_seq),
      event_type: String(row.event_type),

      owner_id: String(row.owner_id),
      approver_id: String(row.approver_id),

      signer_state_hash: String(row.signer_state_hash),

      payload_json: row.payload_json == null ? null : String(row.payload_json),
      shield_hash: String(row.shield_hash),

      created_at: String(row.created_at),
    };
  }

  async getLatestLiabilityShield(decision_id: string): Promise<PlsShieldRecord | null> {
    const row = this.db
      .prepare(
        `SELECT decision_id,event_seq,event_type,owner_id,approver_id,signer_state_hash,payload_json,shield_hash,created_at
        FROM pls_shields
        WHERE decision_id=?
        ORDER BY event_seq DESC
        LIMIT 1;`
      )
      .get(decision_id) as any;

    if (!row) return null;

    return {
      decision_id: String(row.decision_id),
      event_seq: Number(row.event_seq),
      event_type: String(row.event_type),

      owner_id: String(row.owner_id),
      approver_id: String(row.approver_id),

      signer_state_hash: String(row.signer_state_hash),

      payload_json: row.payload_json == null ? null : String(row.payload_json),
      shield_hash: String(row.shield_hash),

      created_at: String(row.created_at),
    };
  }

  // Optional: verify a stored PLS row is internally consistent
  async verifyLiabilityShieldRow(decision_id: string, event_seq: number): Promise<{
    ok: boolean;
    error?: string;
    expected_shield_hash?: string;
    actual_shield_hash?: string;
  }> {
    const r = await this.getLiabilityShield(decision_id, event_seq);
    if (!r) return { ok: false, error: "PLS_NOT_FOUND" };

    const expected = computePlsShieldHash({
      decision_id: r.decision_id,
      event_seq: r.event_seq,
      event_type: r.event_type,
      owner_id: r.owner_id,
      approver_id: r.approver_id,
      signer_state_hash: r.signer_state_hash,
      payload_json: r.payload_json,
      created_at: r.created_at,
    });

    if (expected !== r.shield_hash) {
      return {
        ok: false,
        error: "PLS_SHIELD_HASH_MISMATCH",
        expected_shield_hash: expected,
        actual_shield_hash: r.shield_hash,
      };
    }

    return { ok: true };
  }



  // ---------------------------------
  // ✅ Feature 18: RBAC role management (decision_roles)
  // ---------------------------------
  async grantRole(
    decision_id: string,
    actor_id: string,
    role: string,
    created_at?: string
  ): Promise<void> {
    const at =
      typeof created_at === "string" && created_at.length
        ? created_at
        : new Date().toISOString();

    // idempotent via PRIMARY KEY (decision_id, actor_id, role)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO decision_roles(decision_id, actor_id, role, created_at)
         VALUES (?, ?, ?, ?);`
      )
      .run(String(decision_id), String(actor_id), String(role), at);
  }

  async revokeRole(decision_id: string, actor_id: string, role: string): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM decision_roles
         WHERE decision_id=? AND actor_id=? AND role=?;`
      )
      .run(String(decision_id), String(actor_id), String(role));
  }

  async listRoles(decision_id: string, actor_id?: string): Promise<DecisionRoleRecord[]> {
    const rows = actor_id
      ? (this.db
          .prepare(
            `SELECT decision_id, actor_id, role, created_at
             FROM decision_roles
             WHERE decision_id=? AND actor_id=?
             ORDER BY created_at ASC;`
          )
          .all(String(decision_id), String(actor_id)) as any[])
      : (this.db
          .prepare(
            `SELECT decision_id, actor_id, role, created_at
             FROM decision_roles
             WHERE decision_id=?
             ORDER BY actor_id ASC, role ASC;`
          )
          .all(String(decision_id)) as any[]);

    return rows.map((r) => ({
      decision_id: String(r.decision_id),
      actor_id: String(r.actor_id),
      role: String(r.role),
      created_at: String(r.created_at),
    }));
  }

  async hasAnyRole(decision_id: string, actor_id: string, roles: string[]): Promise<boolean> {
    const list = Array.isArray(roles) ? roles.map(String).filter(Boolean) : [];
    if (list.length === 0) return false;

    // Build (?, ?, ?) safely
    const placeholders = list.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM decision_roles
         WHERE decision_id=? AND actor_id=? AND role IN (${placeholders})
         LIMIT 1;`
      )
      .get(String(decision_id), String(actor_id), ...list) as any;

    return !!row?.ok;
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


  // ---------------------------------
  // ✅ Feature 14: DAG persistence (decision_edges)
  // ---------------------------------
  insertDecisionEdges(edges: DecisionEdgeInput[]): void {
    if (!edges || edges.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO decision_edges (
        from_decision_id,
        to_decision_id,
        relation,
        via_event_seq,
        edge_hash,
        meta_json,
        created_at
      ) VALUES (
        @from_decision_id,
        @to_decision_id,
        @relation,
        @via_event_seq,
        @edge_hash,
        @meta_json,
        @created_at
      );
    `);

    const tx = this.db.transaction((rows: any[]) => {
      for (const r of rows) stmt.run(r);
    });

    const rows = edges.map((e) => {
      const meta_json =
        typeof e.meta === "undefined" ? null : stableStringify(e.meta);

      const edge_hash = sha256Hex(
        stableStringify({
          from_decision_id: e.from_decision_id,
          to_decision_id: e.to_decision_id,
          relation: e.relation,
          via_event_seq: e.via_event_seq,
          meta_json,
        })
      );

      return {
        from_decision_id: e.from_decision_id,
        to_decision_id: e.to_decision_id,
        relation: e.relation,
        via_event_seq: e.via_event_seq,
        edge_hash,
        meta_json,
        created_at: e.created_at,
      };
    });

    tx(rows);
  }


   // ---------------------------------
  // ✅ Feature 14: DAG reads (upstream/downstream)
  
  
  // ---------------------------------
  // ✅ Feature 14: DAG read API
  // ---------------------------------
  async listDecisionEdges(
    decision_id: string,
    direction: "UPSTREAM" | "DOWNSTREAM"
  ): Promise<DecisionEdgeRecord[]> {
    const dir = String(direction);

    // IMPORTANT:
    // Your semantics are:
    // from_decision_id = the decision that "derives from" / "depends on" the to_decision_id.
    // So:
    // - UPSTREAM of X: rows WHERE from_decision_id = X
    // - DOWNSTREAM of X: rows WHERE to_decision_id = X
    const where =
      dir === "DOWNSTREAM"
        ? "to_decision_id = ?"
        : "from_decision_id = ?";

    const rows = this.db
      .prepare(
        `SELECT
           from_decision_id,
           to_decision_id,
           relation,
           via_event_seq,
           edge_hash,
           meta_json,
           created_at
         FROM decision_edges
         WHERE ${where}
         ORDER BY via_event_seq ASC, id ASC;`
      )
      .all(decision_id) as any[];

    return rows.map((r) => ({
      from_decision_id: String(r.from_decision_id),
      to_decision_id: String(r.to_decision_id),
      relation: String(r.relation),
      via_event_seq: Number(r.via_event_seq),
      edge_hash: String(r.edge_hash),
      meta_json: r.meta_json == null ? null : String(r.meta_json),
      created_at: String(r.created_at),
    }));
  }
  


  // -----------------------------
  // decisions
  // -----------------------------
  async createDecision(decision: Decision): Promise<void> {
  const decision_id =
    typeof (decision as any).decision_id === "string" &&
    (decision as any).decision_id.trim().length > 0
      ? String((decision as any).decision_id)
      : null;

  if (!decision_id) {
    throw new Error("SQLITE_STORE_CREATE_DECISION: decision.decision_id is missing");
  }

  const parent_id =
    typeof (decision as any).parent_decision_id === "string" &&
    (decision as any).parent_decision_id.trim().length > 0
      ? String((decision as any).parent_decision_id)
      : null;

  const root_id = parent_id ?? decision_id;

  this.db
    .prepare(
      `INSERT OR IGNORE INTO decisions (decision_id, root_id, version, decision_json)
       VALUES (?, ?, ?, ?);`
    )
    .run(decision_id, root_id, Number((decision as any).version ?? 1), JSON.stringify(decision));
  }

  async putDecision(decision: Decision): Promise<void> {
  const decision_id =
    typeof (decision as any).decision_id === "string" &&
    (decision as any).decision_id.trim().length > 0
      ? String((decision as any).decision_id)
      : null;

  if (!decision_id) {
    throw new Error("SQLITE_STORE_PUT_DECISION: decision.decision_id is missing");
  }

  const parent_id =
    typeof (decision as any).parent_decision_id === "string" &&
    (decision as any).parent_decision_id.trim().length > 0
      ? String((decision as any).parent_decision_id)
      : null;

  const root_id = parent_id ?? decision_id;

  this.db
    .prepare(
      `INSERT INTO decisions (decision_id, root_id, version, decision_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(decision_id) DO UPDATE SET
         root_id=excluded.root_id,
         version=excluded.version,
         decision_json=excluded.decision_json;`
    )
    .run(decision_id, root_id, Number((decision as any).version ?? 1), JSON.stringify(decision));
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
      .prepare(
        `SELECT hash FROM decision_events WHERE decision_id=? AND seq=? LIMIT 1;`
      )
      .get(decision_id, seq) as { hash: string | null } | undefined;

    return row?.hash ?? null;
  }

  // -----------------------------
  // Feature 21 helper: hashes [1..up_to_seq] with gap detection
  // -----------------------------
  private listEventHashesUpToSeq(
    decision_id: string,
    up_to_seq: number
  ): Array<string | null> {
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

    const state_hash: string | null =
      typeof snapAny.state_hash === "string"
        ? snapAny.state_hash
        : snapAny.decision
          ? computeStateHash(snapAny.decision)
          : null;

    const snapshot_json = JSON.stringify({
      ...snapAny,
      snapshot_id,
      created_at: at,
      checkpoint_hash,
      root_hash,
      state_hash,
    });

    this.db
      .prepare(
        `INSERT INTO decision_snapshots
           (decision_id, snapshot_id, at, up_to_seq, snapshot_json, checkpoint_hash, root_hash, state_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(decision_id, snapshot_id) DO UPDATE SET
           at=excluded.at,
           up_to_seq=excluded.up_to_seq,
           snapshot_json=excluded.snapshot_json,
           checkpoint_hash=excluded.checkpoint_hash,
           root_hash=excluded.root_hash,
           state_hash=excluded.state_hash;`
      )
      .run(
        decision_id,
        snapshot_id,
        at,
        up_to_seq,
        snapshot_json,
        checkpoint_hash,
        root_hash,
        state_hash
      );
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

  async pruneSnapshots(
    decision_id: string,
    keep_last_n: number
  ): Promise<{ deleted: number }> {
    const n = Math.max(0, Math.floor(keep_last_n));

    if (n === 0) {
      const info = this.db
        .prepare(`DELETE FROM decision_snapshots WHERE decision_id=?;`)
        .run(decision_id);
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

  async appendEvent(
    decision_id: string,
    input: AppendEventInput
  ): Promise<DecisionEventRecord> {
    return this.runInTransaction(async () => {
      const event: DecisionEvent = input.event;
      const at = input.at;
      const idempotency_key = input.idempotency_key ?? null;

      if (idempotency_key) {
        const existing = await this.findEventByIdempotencyKey(
          decision_id,
          idempotency_key
        );
        if (existing) return existing;
      }

      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM decision_events WHERE decision_id=?;`
        )
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
          .run(
            decision_id,
            seq,
            at,
            JSON.stringify(event),
            idempotency_key,
            prev_hash,
            hash
          );
      } catch (e: any) {
        if (idempotency_key && String(e?.message ?? "").includes("UNIQUE")) {
          const existing2 = await this.findEventByIdempotencyKey(
            decision_id,
            idempotency_key
          );
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

    return rows.map((r) => {
  const ev = JSON.parse(r.event_json) as any;

  // ✅ CRITICAL: ensure deterministic replay/public hashing
  if (!ev.at && r.at) ev.at = r.at;

  return {
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: ev as DecisionEvent,
      idempotency_key: r.idempotency_key ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    };
  });
  }

  async listEventsFrom(
    decision_id: string,
    after_seq: number
  ): Promise<DecisionEventRecord[]> {
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

  return rows.map((r) => {
    const ev = JSON.parse(r.event_json) as any;

    // ✅ CRITICAL: ensure deterministic replay/public hashing
    if (!ev.at && r.at) ev.at = r.at;

    return {
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: ev as DecisionEvent,
      idempotency_key: r.idempotency_key ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    };
  });
  }

  async listEventsTail(
    decision_id: string,
    limit: number
  ): Promise<DecisionEventRecord[]> {
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

  async findEventByIdempotencyKey(
    decision_id: string,
    idempotency_key: string
  ): Promise<DecisionEventRecord | null> {
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

    const ev = JSON.parse(row.event_json) as any;

    // ✅ CRITICAL: ensure deterministic replay/public hashing
    if (!ev.at && row.at) ev.at = row.at;

    return {
      decision_id: row.decision_id,
      seq: row.seq,
      at: row.at,
      event: ev as DecisionEvent,
      idempotency_key: row.idempotency_key ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  async pruneEventsUpToSeq(
    decision_id: string,
    up_to_seq: number
  ): Promise<{ deleted: number }> {
    const info = this.db
      .prepare(`DELETE FROM decision_events WHERE decision_id=? AND seq <= ?;`)
      .run(decision_id, up_to_seq);
    return { deleted: Number(info.changes ?? 0) };
  }

  async getEventBySeq(
    decision_id: string,
    seq: number
  ): Promise<DecisionEventRecord | null> {
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
  private listCompleteEventHashesUpToSeq(
    decision_id: string,
    up_to_seq: number
  ): string[] | null {
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

  async getMerkleProof(
    decision_id: string,
    seq: number,
    up_to_seq: number
  ): Promise<MerkleProof | null> {
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
  // Anchors (Feature 25/26/27 + Feature 32)
  // -----------------------------
  async getLastAnchor(): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq,
                checkpoint_hash, root_hash, state_hash, prev_hash, hash
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
          state_hash: string | null;
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
      state_hash: row.state_hash ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  async getAnchorForSnapshot(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq,
                checkpoint_hash, root_hash, state_hash, prev_hash, hash
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
          state_hash: string | null;
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
      state_hash: row.state_hash ?? null,
      prev_hash: row.prev_hash ?? null,
      hash: row.hash ?? null,
    };
  }

  // compat alias
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

      const existing = await this.getAnchorForSnapshot(
        decision_id,
        snapshot_up_to_seq
      );
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
        state_hash: input.state_hash ?? null,
        prev_hash,
      });

      try {
        this.db
          .prepare(
            `INSERT INTO decision_anchors
              (seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, state_hash, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
          )
          .run(
            seq,
            at,
            decision_id,
            snapshot_up_to_seq,
            input.checkpoint_hash ?? null,
            input.root_hash ?? null,
            input.state_hash ?? null,
            prev_hash,
            hash
          );
      } catch (e: any) {
        if (String(e?.message ?? "").includes("UNIQUE")) {
          const existing2 = await this.getAnchorForSnapshot(
            decision_id,
            snapshot_up_to_seq
          );
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
        state_hash: input.state_hash ?? null,
        prev_hash,
        hash,
      };
    });
  }

  async listAnchors(): Promise<DecisionAnchorRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq,
                checkpoint_hash, root_hash, state_hash, prev_hash, hash
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
      state_hash: string | null;
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
      state_hash: r.state_hash ?? null,
      prev_hash: r.prev_hash ?? null,
      hash: r.hash ?? null,
    }));
  }

  // Re-chain remaining anchors after retention deletes old ones
  private rechainAnchors(): void {
    const rows = this.db
      .prepare(
        `SELECT seq, at, decision_id, snapshot_up_to_seq, checkpoint_hash, root_hash, state_hash
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
      state_hash: string | null;
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
        state_hash: r.state_hash ?? null,
        prev_hash,
      });

      upd.run(prev_hash, hash, r.seq);
      prev_hash = hash;
    }
  }

  async pruneAnchors(
    keep_last_n: number
  ): Promise<{ deleted: number; remaining: number }> {
    return this.runInTransaction(async () => {
      const n = Math.max(0, Math.floor(keep_last_n));

      const beforeRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM decision_anchors;`)
        .get() as { c: number };
      const before = Number(beforeRow?.c ?? 0);

      if (n === 0) {
        const info = this.db.prepare(`DELETE FROM decision_anchors;`).run();
        return { deleted: Number(info.changes ?? 0), remaining: 0 };
      }

      this.db
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

      const afterRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM decision_anchors;`)
        .get() as { c: number };
      const after = Number(afterRow?.c ?? 0);

      return { deleted: before - after, remaining: after };
    });
  }


    // ---------------------------------
  // ✅ Feature 9: Forensic verification API
  // The example script likely expects store.verifyHashChain()
  // ---------------------------------
  async verifyHashChain(decision_id: string): Promise<{
    verified: boolean;
    errors: Array<{
      seq: number;
      code: string;
      message: string;
      expected?: string | null;
      actual?: string | null;
    }>;
  }> {
    const rows = this.db
      .prepare(
        `SELECT seq, at, event_json, idempotency_key, prev_hash, hash
         FROM decision_events
         WHERE decision_id=?
         ORDER BY seq ASC;`
      )
      .all(decision_id) as Array<{
      seq: number;
      at: string;
      event_json: string;
      idempotency_key: string | null;
      prev_hash: string | null;
      hash: string | null;
    }>;

    const errors: Array<{
      seq: number;
      code: string;
      message: string;
      expected?: string | null;
      actual?: string | null;
    }> = [];

    let prev: string | null = null;

    for (const r of rows) {
      const event = JSON.parse(r.event_json) as DecisionEvent;

      // 1) prev_hash must match previous computed/stored hash
      const expectedPrev = prev;
      const actualPrev = r.prev_hash ?? null;

      if (actualPrev !== expectedPrev) {
        errors.push({
          seq: r.seq,
          code: "PREV_HASH_MISMATCH",
          message: "prev_hash does not match previous event hash",
          expected: expectedPrev,
          actual: actualPrev,
        });
      }

      // 2) hash must exist
      if (!r.hash) {
        errors.push({
          seq: r.seq,
          code: "MISSING_HASH",
          message: "event hash is missing (null/empty)",
          expected: null,
          actual: r.hash ?? null,
        });
        // even if missing, continue computing expected chain so we can report more issues
      }

      // 3) recompute hash and compare
      const expectedHash = computeEventHash({
        decision_id,
        seq: r.seq,
        at: r.at,
        idempotency_key: r.idempotency_key ?? null,
        event,
        prev_hash: expectedPrev,
      });

      const actualHash = r.hash ?? null;

      if (actualHash !== expectedHash) {
        errors.push({
          seq: r.seq,
          code: "HASH_MISMATCH",
          message: "event hash does not match recomputed hash",
          expected: expectedHash,
          actual: actualHash,
        });
      }

      // advance chain with the expected hash (canonical)
      prev = expectedHash;
    }

    return { verified: errors.length === 0, errors };
  }



    // -----------------------------
    // Feature 11-x: Enterprise Ledger (tenant-aware + export + verify + signing)
    // 11-3: optional signature enforcement policy (OFF by default)
    // 11-4: verifierRegistry support (optional)
    // 11-5: trust summary comes from verifyLedgerEntries (ledger.ts)
    // -----------------------------

    // 11-3 (optional): set policy if you want to enforce signatures for some/all entry types
    private enterpriseLedgerPolicy: {
      require_signatures?: boolean;
      require_signatures_for_types?: LedgerEntryType[];
    } = {};

    public setEnterpriseLedgerPolicy(p: {
      require_signatures?: boolean;
      require_signatures_for_types?: LedgerEntryType[];
    }) {
      this.enterpriseLedgerPolicy = { ...p };
    }

    private signatureRequiredForEnterpriseType(type: LedgerEntryType): boolean {
      const requireAll = this.enterpriseLedgerPolicy.require_signatures === true;
      const requireFor = new Set(this.enterpriseLedgerPolicy.require_signatures_for_types ?? []);
      return requireAll || requireFor.has(type);
    }

    private getLastLedgerHash(): string | null {
      const row = this.db
        .prepare(`SELECT hash FROM enterprise_ledger ORDER BY seq DESC LIMIT 1;`)
        .get() as { hash: string | null } | undefined;
      return row?.hash ?? null;
    }

    async appendLedgerEntry(
      input: Omit<LedgerEntry, "seq" | "prev_hash" | "hash" | "sig_alg" | "key_id" | "sig"> & {
        signer?: LedgerSigner;
      }
    ): Promise<LedgerEntry> {
      return this.runInTransaction(async () => {
        // ✅ 11-3: enforce if policy says so (default OFF)
        if (this.signatureRequiredForEnterpriseType(input.type as LedgerEntryType) && !input.signer) {
          throw new Error(
            `LEDGER_SIGNATURE_REQUIRED: type=${input.type} requires signer but signer was not provided`
          );
        }

        const row = this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM enterprise_ledger;`)
          .get() as { max_seq: number };

        const seq = (row?.max_seq ?? 0) + 1;
        const prev_hash = this.getLastLedgerHash();

        const entryBase: Omit<LedgerEntry, "hash"> = {
          seq,
          at: input.at,
          tenant_id: input.tenant_id ?? null,
          type: input.type as LedgerEntryType,

          decision_id: input.decision_id ?? null,
          event_seq: input.event_seq ?? null,
          snapshot_up_to_seq: input.snapshot_up_to_seq ?? null,
          anchor_seq: input.anchor_seq ?? null,

          payload: input.payload ?? null,
          prev_hash,

          // signature fields computed after hash
          sig_alg: null,
          key_id: null,
          sig: null,
        };

        const hash = computeLedgerEntryHash({
          seq: entryBase.seq,
          at: entryBase.at,
          tenant_id: entryBase.tenant_id,
          type: entryBase.type as any,
          decision_id: entryBase.decision_id,
          event_seq: entryBase.event_seq,
          snapshot_up_to_seq: entryBase.snapshot_up_to_seq,
          anchor_seq: entryBase.anchor_seq,
          payload: entryBase.payload,
          prev_hash: entryBase.prev_hash,
        });

        // ✅ sign AFTER hash is computed
        const sigParts = signLedgerHash(hash, input.signer);

        this.db
          .prepare(
            `INSERT INTO enterprise_ledger
              (seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
              payload_json, prev_hash, hash, sig_alg, key_id, sig)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
          )
          .run(
            seq,
            entryBase.at,
            entryBase.tenant_id ?? null,
            entryBase.type,
            entryBase.decision_id ?? null,
            entryBase.event_seq ?? null,
            entryBase.snapshot_up_to_seq ?? null,
            entryBase.anchor_seq ?? null,
            JSON.stringify(entryBase.payload ?? null),
            prev_hash,
            hash,
            sigParts.sig_alg,
            sigParts.key_id,
            sigParts.sig
          );

        return {
          ...entryBase,
          hash,
          sig_alg: sigParts.sig_alg,
          key_id: sigParts.key_id,
          sig: sigParts.sig,
        };
      });
    }

    // Backward compatible overloads:
    // - listLedgerEntries(200)
    // - listLedgerEntries({ tenant_id: "TENANT_A", limit: 50 })
    async listLedgerEntries(limit: number): Promise<LedgerEntry[]>;
    async listLedgerEntries(query?: LedgerQuery): Promise<LedgerEntry[]>;
    async listLedgerEntries(arg: any = {}): Promise<LedgerEntry[]> {
      const query: LedgerQuery =
        typeof arg === "number" ? { limit: arg } : (arg ?? {});

      const limit = Math.max(1, Math.floor(query.limit ?? 200));

      const rows = query.tenant_id
        ? (this.db
            .prepare(
              `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                      payload_json, prev_hash, hash, sig_alg, key_id, sig
              FROM enterprise_ledger
              WHERE tenant_id=?
              ORDER BY seq ASC
              LIMIT ?;`
            )
            .all(query.tenant_id, limit) as any[])
        : (this.db
            .prepare(
              `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                      payload_json, prev_hash, hash, sig_alg, key_id, sig
              FROM enterprise_ledger
              ORDER BY seq ASC
              LIMIT ?;`
            )
            .all(limit) as any[]);

      return rows.map((r) => ({
        seq: Number(r.seq),
        at: String(r.at),
        tenant_id: r.tenant_id ?? null,
        type: String(r.type) as LedgerEntryType,
        decision_id: r.decision_id ?? null,
        event_seq: r.event_seq == null ? null : Number(r.event_seq),
        snapshot_up_to_seq: r.snapshot_up_to_seq == null ? null : Number(r.snapshot_up_to_seq),
        anchor_seq: r.anchor_seq == null ? null : Number(r.anchor_seq),
        payload: r.payload_json ? JSON.parse(String(r.payload_json)) : null,
        prev_hash: r.prev_hash ?? null,
        hash: String(r.hash),
        sig_alg: (r.sig_alg ?? null) as any,
        key_id: r.key_id ?? null,
        sig: r.sig ?? null,
      }));
    }

    async exportLedgerRange(input: { from_seq: number; to_seq: number }): Promise<LedgerEntry[]> {
      const from = Math.floor(input.from_seq);
      const to = Math.floor(input.to_seq);
      if (from <= 0 || to < from) return [];

      const rows = this.db
        .prepare(
          `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                  payload_json, prev_hash, hash, sig_alg, key_id, sig
          FROM enterprise_ledger
          WHERE seq BETWEEN ? AND ?
          ORDER BY seq ASC;`
        )
        .all(from, to) as any[];

      return rows.map((r) => ({
        seq: Number(r.seq),
        at: String(r.at),
        tenant_id: r.tenant_id ?? null,
        type: String(r.type) as LedgerEntryType,
        decision_id: r.decision_id ?? null,
        event_seq: r.event_seq == null ? null : Number(r.event_seq),
        snapshot_up_to_seq: r.snapshot_up_to_seq == null ? null : Number(r.snapshot_up_to_seq),
        anchor_seq: r.anchor_seq == null ? null : Number(r.anchor_seq),
        payload: r.payload_json ? JSON.parse(String(r.payload_json)) : null,
        prev_hash: r.prev_hash ?? null,
        hash: String(r.hash),
        sig_alg: (r.sig_alg ?? null) as any,
        key_id: r.key_id ?? null,
        sig: r.sig ?? null,
      }));
    }

    async verifyLedger(opts: VerifyLedgerOptions = {}): Promise<LedgerVerifyReport> {
      const entries = await this.listLedgerEntries({ limit: 1_000_000 });
      return verifyLedgerEntries(entries, {
        require_signatures: opts.require_signatures ?? false,
        resolveVerifier: opts.resolveVerifier,
        verifierRegistry: (opts as any).verifierRegistry, // ✅ 11-4 (optional)
      });
    }


}