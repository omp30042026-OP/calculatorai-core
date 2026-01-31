//
// Negative test: prove anchor-chain tamper detection works.
// Creates a small decision, generates snapshots+anchors (Option 1),
// then directly tampers with the anchor table and verifies we FAIL.
//
// Run:
//   tsx examples/run-decision-anchor-tamper-sqlite.ts
//

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { SqliteDecisionSnapshotStore } from "../packages/decision/src/sqlite-snapshot-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { computeAnchorHash, type DecisionAnchorRecord } from "../packages/decision/src/anchors.js";

function assert(cond: any, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function tmpDbPath(name: string) {
  const p = path.join(os.tmpdir(), name);
  try {
    fs.rmSync(p, { force: true });
  } catch {}
  return p;
}

// Safely find the real anchor table name in sqlite.
// We look for a table that:
// - name contains "anchor"
// - has columns: seq, hash, prev_hash (typical)
// We then return that table name for UPDATE.
function findAnchorTableOrThrow(db: any): string {
  const tables: Array<{ name: string }> = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type='table'
         AND name LIKE '%anchor%'`
    )
    .all();

  const isSafeIdent = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

  for (const t of tables) {
    const name = String(t.name ?? "");
    if (!name || !isSafeIdent(name)) continue;

    const cols: Array<{ name: string }> = db.prepare(`PRAGMA table_info(${name})`).all();
    const colset = new Set(cols.map((c) => String(c.name)));

    // We need at least these to perform the tamper + verify logic.
    if (colset.has("seq") && colset.has("hash") && colset.has("prev_hash")) {
      return name;
    }
  }

  // If we didn’t find it, print helpful debugging info.
  const allTables: Array<{ name: string }> = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all();

  throw new Error(
    `Could not locate anchor table. Tables seen: ${allTables.map((x) => x.name).join(", ")}`
  );
}

function verifyAnchorChainOrThrow(anchors: DecisionAnchorRecord[]) {
  // Empty is valid
  if (!anchors.length) return;

  // Must be seq-sorted
  const sorted = [...anchors].sort((a, b) => Number(a.seq) - Number(b.seq));

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const prev = i === 0 ? null : sorted[i - 1]!;

    // Linkage check
    const expectedPrevHash = prev ? (prev.hash ?? null) : null;
    const gotPrevHash = a.prev_hash ?? null;

    if (gotPrevHash !== expectedPrevHash) {
      throw new Error(
        `ANCHOR_PREV_HASH_MISMATCH at seq=${a.seq}: expected ${expectedPrevHash}, got ${gotPrevHash}`
      );
    }

    // Hash check (recompute)
    const expectedHash = computeAnchorHash({
      seq: a.seq,
      at: a.at,
      decision_id: a.decision_id,
      snapshot_up_to_seq: a.snapshot_up_to_seq,
      checkpoint_hash: a.checkpoint_hash ?? null,
      root_hash: a.root_hash ?? null,
      state_hash: a.state_hash ?? null,
      prev_hash: a.prev_hash ?? null,
    });

    const gotHash = a.hash ?? null;
    if (!gotHash || gotHash !== expectedHash) {
      throw new Error(
        `ANCHOR_HASH_MISMATCH at seq=${a.seq}: expected ${expectedHash}, got ${gotHash}`
      );
    }
  }
}

async function main() {
  const dbPath = tmpDbPath(`calculatorai-anchor-tamper-${Date.now()}.sqlite`);

  // SqliteDecisionStore(filePath: string)
  const store = new SqliteDecisionStore(dbPath as any);

  // Snapshots store (same db file)
  const snapshotStore = new SqliteDecisionSnapshotStore((store as any).db);

  // Option 1: anchors are produced from snapshot pipeline.
  // Your SqliteDecisionStore implements anchor methods (appendAnchor/listAnchors).
  const anchorStore = store as any;

  // ---- 1) Create a decision and force snapshots+anchors ----
  const decision_id = `d_anchor_tamper_${Date.now()}`;

  // Make snapshots frequently so we produce multiple anchors quickly.
  const snapshotPolicy = { every_n_events: 1 };
  const anchorPolicy = { enabled: true };

  // Use event types that definitely exist in your engine.
  const events = [
    {
      type: "ATTACH_ARTIFACTS",
      actor_id: "seed",
      actor_type: "system",
      artifacts: { extra: { note: "v1" } },
    },
    {
      type: "ATTACH_ARTIFACTS",
      actor_id: "seed",
      actor_type: "system",
      artifacts: { extra: { note: "v2" } },
    },
    {
      type: "ATTACH_ARTIFACTS",
      actor_id: "seed",
      actor_type: "system",
      artifacts: { extra: { note: "v3" } },
    },
  ] as any[];

  for (const ev of events) {
    const r = await applyEventWithStore(
      store as any,
      {
        decision_id,
        event: ev,
        snapshotStore: snapshotStore as any,
        snapshotPolicy: snapshotPolicy as any,
        anchorStore,
        anchorPolicy: anchorPolicy as any,
        anchorRetentionPolicy: { keep_last_n_anchors: 999 },
      } as any,
      {
        // deterministic time
        now: () => "2026-01-01T00:00:00.000Z",
      } as any
    );

    if (!r.ok) {
      console.log("applyEventWithStore violation(s):", (r as any).violations ?? []);
    }
    assert(r.ok, `applyEventWithStore failed for ${ev.type}`);
  }

  // Read anchors
  assert(typeof (anchorStore as any).listAnchors === "function", "Store has no listAnchors()");
  const anchorsBefore: DecisionAnchorRecord[] = await (anchorStore as any).listAnchors();

  assert(anchorsBefore.length >= 2, `Expected >=2 anchors, got ${anchorsBefore.length}`);

  // ---- 2) Verify chain passes before tamper ----
  verifyAnchorChainOrThrow(anchorsBefore);

  // ---- 3) Tamper directly in DB ----
  const db = (store as any).db;
  assert(db, "SqliteDecisionStore must expose .db (better-sqlite3) for this test");

  const targetSeq =
    anchorsBefore.find((a) => a.seq === 2)?.seq ??
    anchorsBefore[Math.min(1, anchorsBefore.length - 1)]!.seq;

  const anchorTable = findAnchorTableOrThrow(db);

  // Minimal tamper: change hash, leave everything else unchanged.
  db.prepare(`UPDATE ${anchorTable} SET hash=? WHERE seq=?`).run("00".repeat(32), targetSeq);

  const anchorsAfter: DecisionAnchorRecord[] = await (anchorStore as any).listAnchors();

  // ---- 4) Verify chain FAILS after tamper ----
  let failed = false;
  try {
    verifyAnchorChainOrThrow(anchorsAfter);
  } catch (e) {
    failed = true;
    console.log(`✅ anchor tamper detected as expected (${String((e as any)?.message ?? e)})`);
  }

  if (!failed) {
    throw new Error("❌ Expected anchor verification to fail after tamper, but it passed");
  }

  console.log(
    `✅ decision anchor tamper sqlite ok (${anchorsAfter.length} anchors, tampered seq=${targetSeq}, table=${anchorTable})`
  );
}

main().catch((e) => {
  console.error("❌ run-decision-anchor-tamper-sqlite failed:", e);
  process.exit(1);
});

