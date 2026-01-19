// packages/decision/src/sqlite-ledger-store.ts
import Database from "better-sqlite3";

import type {
  AppendLedgerEntryInput,
  DecisionLedgerStore,
  ExportLedgerRangeInput,
  VerifyLedgerOptions,
  LedgerWritePolicy,
} from "./ledger-store.js";

import type { LedgerEntry, LedgerQuery, LedgerEntryType } from "./ledger.js";
import { computeLedgerEntryHash, signLedgerHash, verifyLedgerEntries } from "./ledger.js";

export class SqliteDecisionLedgerStore implements DecisionLedgerStore {
  private db: Database.Database;
  private _sp = 0;

  // ✅ Feature 11-3: optional enforcement
  private policy: LedgerWritePolicy;

  constructor(filename: string, opts?: { policy?: LedgerWritePolicy }) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.policy = opts?.policy ?? {};
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_ledger (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        tenant_id TEXT,

        type TEXT NOT NULL,

        decision_id TEXT,
        event_seq INTEGER,
        snapshot_up_to_seq INTEGER,
        anchor_seq INTEGER,

        payload_json TEXT NOT NULL,

        prev_hash TEXT,
        hash TEXT NOT NULL,

        sig_alg TEXT,
        key_id TEXT,
        sig TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decision_ledger_tenant_seq
      ON decision_ledger (tenant_id, seq);
    `);
  }

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

  private signatureRequiredForType(type: LedgerEntryType): boolean {
    const requireAll = this.policy.require_signatures === true;
    const requireFor = new Set(this.policy.require_signatures_for_types ?? []);
    return requireAll || requireFor.has(type);
  }

  async appendLedgerEntry(input: AppendLedgerEntryInput): Promise<LedgerEntry> {
    return this.runInTransaction(async () => {
      // ✅ Feature 11-3: enforce signature policy (opt-in)
      if (this.signatureRequiredForType(input.type as LedgerEntryType) && !input.signer) {
        throw new Error(
          `LEDGER_SIGNATURE_REQUIRED: type=${input.type} requires signer but signer was not provided`
        );
      }

      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM decision_ledger;`)
        .get() as { max_seq: number };

      const seq = (row?.max_seq ?? 0) + 1;

      const last = this.db
        .prepare(`SELECT hash FROM decision_ledger ORDER BY seq DESC LIMIT 1;`)
        .get() as { hash: string | null } | undefined;

      const prev_hash = last?.hash ?? null;

      const hash = computeLedgerEntryHash({
        seq,
        at: input.at,
        tenant_id: input.tenant_id ?? null,
        type: input.type as any,
        decision_id: input.decision_id ?? null,
        event_seq: input.event_seq ?? null,
        snapshot_up_to_seq: input.snapshot_up_to_seq ?? null,
        anchor_seq: input.anchor_seq ?? null,
        payload: input.payload ?? null,
        prev_hash,
      });

      // ✅ sign AFTER hash is computed
      const sigParts = signLedgerHash(hash, input.signer);

      this.db
        .prepare(
          `INSERT INTO decision_ledger
            (seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
             payload_json, prev_hash, hash, sig_alg, key_id, sig)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
        )
        .run(
          seq,
          input.at,
          input.tenant_id ?? null,
          input.type,
          input.decision_id ?? null,
          input.event_seq ?? null,
          input.snapshot_up_to_seq ?? null,
          input.anchor_seq ?? null,
          JSON.stringify(input.payload ?? null),
          prev_hash,
          hash,
          sigParts.sig_alg,
          sigParts.key_id,
          sigParts.sig
        );

      return {
        seq,
        at: input.at,
        tenant_id: input.tenant_id ?? null,
        type: input.type as any,
        decision_id: input.decision_id ?? null,
        event_seq: input.event_seq ?? null,
        snapshot_up_to_seq: input.snapshot_up_to_seq ?? null,
        anchor_seq: input.anchor_seq ?? null,
        payload: input.payload ?? null,
        prev_hash,
        hash,
        sig_alg: sigParts.sig_alg,
        key_id: sigParts.key_id,
        sig: sigParts.sig,
      };
    });
  }

  async listLedgerEntries(query: LedgerQuery = {}): Promise<LedgerEntry[]> {
    const limit = Math.max(1, Math.floor(query.limit ?? 50));

    const rows = query.tenant_id
      ? (this.db
          .prepare(
            `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                    payload_json, prev_hash, hash, sig_alg, key_id, sig
             FROM decision_ledger
             WHERE tenant_id=?
             ORDER BY seq ASC
             LIMIT ?;`
          )
          .all(query.tenant_id, limit) as any[])
      : (this.db
          .prepare(
            `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                    payload_json, prev_hash, hash, sig_alg, key_id, sig
             FROM decision_ledger
             ORDER BY seq ASC
             LIMIT ?;`
          )
          .all(limit) as any[]);

    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      tenant_id: r.tenant_id ?? null,
      type: String(r.type) as any,
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

  async exportLedgerRange(input: ExportLedgerRangeInput): Promise<LedgerEntry[]> {
    const from = Math.floor(input.from_seq);
    const to = Math.floor(input.to_seq);
    if (from <= 0 || to < from) return [];

    const rows = this.db
      .prepare(
        `SELECT seq, at, tenant_id, type, decision_id, event_seq, snapshot_up_to_seq, anchor_seq,
                payload_json, prev_hash, hash, sig_alg, key_id, sig
         FROM decision_ledger
         WHERE seq BETWEEN ? AND ?
         ORDER BY seq ASC;`
      )
      .all(from, to) as any[];

    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      tenant_id: r.tenant_id ?? null,
      type: String(r.type) as any,
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

  async verifyLedger(opts: VerifyLedgerOptions = {}) {
    const entries = await this.listLedgerEntries({ limit: 1_000_000 });

    return verifyLedgerEntries(entries, {
      require_signatures: opts.require_signatures ?? false,
      resolveVerifier: opts.resolveVerifier,
      verifierRegistry: opts.verifierRegistry,
    });
  }
}


