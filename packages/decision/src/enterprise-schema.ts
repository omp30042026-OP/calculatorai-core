// packages/decision/src/enterprise-schema.ts
export function ensureEnterpriseTables(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_roles (
      decision_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (decision_id, actor_id, role)
    );

    CREATE TABLE IF NOT EXISTS liability_receipts (
      decision_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,

      receipt_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'VERITASCALE_LIABILITY_RECEIPT_V1',
      receipt_hash TEXT,

      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,

      trust_score REAL NOT NULL,
      trust_reason TEXT NOT NULL,

      -- PRIVATE / tamper-hash (store-layer tolerant)
      state_before_hash TEXT,
      state_after_hash TEXT,

      -- ✅ NEW: PUBLIC / canonical state hash (verifiable by external parties)
      public_state_before_hash TEXT,
      public_state_after_hash TEXT,

      -- ✅ Personal Liability Shield (PLS) fields
      role TEXT,
      scope TEXT,
      risk_acceptance TEXT,
      obligations_hash TEXT,

      created_at TEXT NOT NULL,

      PRIMARY KEY (decision_id, event_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_liability_decision_seq
      ON liability_receipts(decision_id, event_seq);

    CREATE INDEX IF NOT EXISTS idx_liability_actor_created
      ON liability_receipts(actor_id, created_at DESC);

    -- ✅ Feature 21/22: Risk & Liability signatures
    CREATE TABLE IF NOT EXISTS risk_liability_signatures (
      decision_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,

      actor_id TEXT,
      actor_type TEXT,

      receipt_hash TEXT,
      state_before_hash TEXT,
      state_after_hash TEXT,
      obligations_hash TEXT,

      amount_value REAL,
      amount_currency TEXT,

      signature_kind TEXT NOT NULL DEFAULT 'RISK_LIABILITY_SIGNATURE_V1',
      signature_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,

      created_at TEXT NOT NULL,

      PRIMARY KEY (decision_id, event_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_risk_sig_decision_seq
      ON risk_liability_signatures(decision_id, event_seq);

    CREATE INDEX IF NOT EXISTS idx_risk_sig_actor_created
      ON risk_liability_signatures(actor_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workflows (
      decision_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      template_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (decision_id, workflow_id)
    );

    CREATE TABLE IF NOT EXISTS external_attestations (
      attestation_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      signer TEXT NOT NULL,
      signature TEXT,
      created_at TEXT NOT NULL,
      meta_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attestations_decision_created
      ON external_attestations(decision_id, created_at DESC);
  `);

  db.prepare(`
    CREATE TABLE IF NOT EXISTS decision_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- graph
      from_decision_id TEXT NOT NULL,
      to_decision_id   TEXT NOT NULL,
      relation         TEXT NOT NULL, -- e.g. DERIVED_FROM, FORKED_FROM, MERGED_FROM, REFERENCES

      -- anchor to event timeline
      via_event_seq INTEGER NOT NULL,

      -- deterministic + cryptographically bindable
      edge_hash TEXT NOT NULL,

      -- optional metadata (stable stringify payload)
      meta_json TEXT NULL,

      created_at TEXT NOT NULL,

      -- prevent duplicates
      UNIQUE(from_decision_id, to_decision_id, relation, via_event_seq)
    );
  `).run();


  // ✅ Feature 15 (Option B): Personal Liability Shield (PLS) - auditable table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pls_shields (
      decision_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,

      owner_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,

      signer_state_hash TEXT NOT NULL,

      payload_json TEXT,          -- optional: responsibility/approver/impact canonical payload
      shield_hash TEXT NOT NULL,  -- sha256 of canonical payload

      created_at TEXT NOT NULL,

      PRIMARY KEY (decision_id, event_seq)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pls_shields_decision
    ON pls_shields (decision_id, event_seq);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pls_shields_approver
    ON pls_shields (approver_id, created_at);
  `);

  // Optional: prevent same shield payload being inserted multiple times across decisions/events
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pls_shields_shield_hash
    ON pls_shields (shield_hash);
  `);

  // migrations for older DBs (safe no-op if columns exist)
  try {
    const cols = (db.prepare(`PRAGMA table_info(pls_shields);`).all() as any[]).map((r) => r.name);
    const ensure = (c: string, t: string) => { if (!cols.includes(c)) db.exec(`ALTER TABLE pls_shields ADD COLUMN ${c} ${t};`); };

    ensure("event_type", "TEXT");
    ensure("owner_id", "TEXT");
    ensure("approver_id", "TEXT");
    ensure("signer_state_hash", "TEXT");
    ensure("payload_json", "TEXT");
    ensure("shield_hash", "TEXT");
    ensure("created_at", "TEXT");
  } catch {}



  db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_from ON decision_edges(from_decision_id);`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_to ON decision_edges(to_decision_id);`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_to_seq ON decision_edges(to_decision_id, via_event_seq);`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_to_relation ON decision_edges(to_decision_id, relation);`).run();

  // -----------------------------
  // 🔧 best-effort migrations (SQLite has no ADD COLUMN IF NOT EXISTS)
  // -----------------------------
  try {
    db.exec(`ALTER TABLE liability_receipts ADD COLUMN public_state_before_hash TEXT;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE liability_receipts ADD COLUMN public_state_after_hash TEXT;`);
  } catch {}
}


