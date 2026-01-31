import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import type { DecisionAnchorRecord, DecisionAnchorStore } from "../packages/decision/src/anchors.js";
import { computeAnchorHash } from "../packages/decision/src/anchors.js";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------
// sqlite anchor table
// ---------------------------------------------
function ensureAnchorTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_anchors (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,
      at                TEXT NOT NULL,

      decision_id       TEXT NOT NULL,
      snapshot_up_to_seq INTEGER NOT NULL,

      checkpoint_hash   TEXT NULL,
      root_hash         TEXT NULL,
      state_hash        TEXT NULL,

      prev_hash         TEXT NULL,
      hash              TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_decision_anchors_decision
      ON decision_anchors(decision_id, snapshot_up_to_seq);

    CREATE INDEX IF NOT EXISTS idx_decision_anchors_seq
      ON decision_anchors(seq);
  `);
}

// ---------------------------------------------
// inline sqlite anchor store (Option 1)
// ---------------------------------------------
class InlineSqliteDecisionAnchorStore implements DecisionAnchorStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    ensureAnchorTable(this.db);
  }

  async getLastAnchor(): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM decision_anchors
         ORDER BY seq DESC
         LIMIT 1`
      )
      .get();

    return row ?? null;
  }

  async getAnchorForSnapshot(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM decision_anchors
         WHERE decision_id=? AND snapshot_up_to_seq=?
         ORDER BY seq DESC
         LIMIT 1`
      )
      .get(decision_id, snapshot_up_to_seq);

    return row ?? null;
  }

  async findAnchorByCheckpoint(
    decision_id: string,
    snapshot_up_to_seq: number
  ) {
    return this.getAnchorForSnapshot(decision_id, snapshot_up_to_seq);
  }

  async listAnchors(): Promise<DecisionAnchorRecord[]> {
    return this.db
      .prepare(`SELECT * FROM decision_anchors ORDER BY seq ASC`)
      .all();
  }

  async appendAnchor(
    input: Omit<DecisionAnchorRecord, "seq" | "prev_hash" | "hash">
  ): Promise<DecisionAnchorRecord> {
    const last = await this.getLastAnchor();
    const prev_hash = last?.hash ?? null;

    const insert = this.db.prepare(`
      INSERT INTO decision_anchors(
        at,
        decision_id,
        snapshot_up_to_seq,
        checkpoint_hash,
        root_hash,
        state_hash,
        prev_hash,
        hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    const info = insert.run(
      input.at,
      input.decision_id,
      input.snapshot_up_to_seq,
      input.checkpoint_hash ?? null,
      input.root_hash ?? null,
      input.state_hash ?? null,
      prev_hash
    );

    const seq = Number(info.lastInsertRowid);

    const hash = computeAnchorHash({
      seq,
      at: input.at,
      decision_id: input.decision_id,
      snapshot_up_to_seq: input.snapshot_up_to_seq,
      checkpoint_hash: input.checkpoint_hash ?? null,
      root_hash: input.root_hash ?? null,
      state_hash: input.state_hash ?? null,
      prev_hash,
    });

    this.db
      .prepare(`UPDATE decision_anchors SET hash=? WHERE seq=?`)
      .run(hash, seq);

    return this.db
      .prepare(`SELECT * FROM decision_anchors WHERE seq=?`)
      .get(seq);
  }

  async pruneAnchors(keep_last_n: number) {
    if (keep_last_n <= 0) {
      const d = this.db.prepare(`DELETE FROM decision_anchors`).run();
      return { deleted: d.changes, remaining: 0 };
    }

    const d = this.db
      .prepare(
        `DELETE FROM decision_anchors
         WHERE seq NOT IN (
           SELECT seq FROM decision_anchors
           ORDER BY seq DESC
           LIMIT ?
         )`
      )
      .run(keep_last_n);

    const r = this.db
      .prepare(`SELECT COUNT(*) as c FROM decision_anchors`)
      .get();

    return { deleted: d.changes, remaining: r.c };
  }
}

// ---------------------------------------------
// anchor chain verification
// ---------------------------------------------
function assertAnchorChain(anchors: DecisionAnchorRecord[]) {
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;

    if (i === 0) {
      // genesis anchor
      continue;
    }

    const prev = anchors[i - 1]!;
    if (a.prev_hash !== prev.hash) {
      throw new Error(`ANCHOR_CHAIN_BROKEN at seq=${a.seq}`);
    }

    const expected = computeAnchorHash({
      seq: a.seq,
      at: a.at,
      decision_id: a.decision_id,
      snapshot_up_to_seq: a.snapshot_up_to_seq,
      checkpoint_hash: a.checkpoint_hash ?? null,
      root_hash: a.root_hash ?? null,
      state_hash: a.state_hash ?? null,
      prev_hash: a.prev_hash ?? null,
    });

    if (a.hash !== expected) {
      throw new Error(`ANCHOR_HASH_MISMATCH at seq=${a.seq}`);
    }
  }
}

// ---------------------------------------------
// main test
// ---------------------------------------------
async function main() {
  const tmpDir = path.join(process.cwd(), ".tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const dbFile = path.join(tmpDir, "decision-anchors.sqlite");
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  // ✅ FIX #1: pass filename string
  const store: any = new SqliteDecisionStore(dbFile);
  const db = store.db;
  if (!db) throw new Error("SqliteDecisionStore.db not exposed");

  const anchorStore = new InlineSqliteDecisionAnchorStore(db);

  const now = new Date().toISOString();

  await anchorStore.appendAnchor({
    at: now,
    decision_id: "D1",
    snapshot_up_to_seq: 10,
    checkpoint_hash: "chk10",
    root_hash: "root10",
    state_hash: "state10",
  });

  await anchorStore.appendAnchor({
    at: now,
    decision_id: "D1",
    snapshot_up_to_seq: 20,
    checkpoint_hash: "chk20",
    root_hash: "root20",
    state_hash: "state20",
  });

  await anchorStore.appendAnchor({
    at: now,
    decision_id: "D2",
    snapshot_up_to_seq: 5,
    checkpoint_hash: "chk5",
    root_hash: "root5",
    state_hash: "state5",
  });

  const anchors = await anchorStore.listAnchors();
  assertAnchorChain(anchors);

  const found = await anchorStore.getAnchorForSnapshot("D1", 20);
  if (!found) throw new Error("ANCHOR_LOOKUP_FAILED");

  console.log(`✅ decision anchors sqlite ok (${anchors.length} anchors)`);
}

main().catch((e) => {
  console.error("❌ run-decision-anchors-sqlite failed:", e);
  process.exit(1);
});

