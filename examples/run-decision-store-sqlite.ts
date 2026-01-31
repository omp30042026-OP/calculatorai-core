// examples/run-decision-store-sqlite.ts
import Database from "better-sqlite3";

import type { Decision } from "../packages/decision/src/decision.js";
import type { DecisionEvent } from "../packages/decision/src/events.js";
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import type { DecisionEventRecord, DecisionStore } from "../packages/decision/src/store.js";
import type {
  DecisionSnapshot,
  DecisionSnapshotStore,
  SnapshotPolicy,
} from "../packages/decision/src/snapshots.js";

// ---- assert helper that prints violations ----
function assertOk(r: any, label: string) {
  if (!r || typeof r !== "object") {
    throw new Error(`${label} failed: no result object`);
  }
  if (r.ok === false) {
    throw new Error(
      `${label} failed: ` + JSON.stringify(r.violations ?? [], null, 2)
    );
  }
  if (r.ok !== true) {
    throw new Error(`${label} failed: unexpected result.ok = ${String(r.ok)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}


// ---- deterministic now() for replay ----
function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1; // +1ms each call
    return iso;
  };
}

// ---- SQLite-backed DecisionStore (root/current separated via kind) ----
export class SqliteDecisionStore implements DecisionStore {
  public db: Database.Database; // 👈 make it public so examples can query/tamper the same DB

  constructor(filenameOrDb: string | Database.Database = ":memory:") {
    this.db = typeof filenameOrDb === "string" ? new Database(filenameOrDb) : filenameOrDb;
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }
  
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id   TEXT NOT NULL,
        kind          TEXT NOT NULL, -- "root" | "current"
        decision_json TEXT NOT NULL,
        PRIMARY KEY (decision_id, kind)
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_kind
        ON decisions(decision_id, kind);

      CREATE TABLE IF NOT EXISTS decision_events (
        decision_id TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        at          TEXT NOT NULL,
        event_json  TEXT NOT NULL,
        PRIMARY KEY (decision_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_decision
        ON decision_events(decision_id, seq);
    `);
  }

  async createDecision(decision: Decision): Promise<void> {
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
        `SELECT decision_json FROM decisions WHERE decision_id = ? AND kind = 'current' LIMIT 1`
      )
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async getRootDecision(decision_id: string): Promise<Decision | null> {
    const row = this.db
      .prepare(`SELECT decision_json FROM decisions WHERE decision_id = ? AND kind = 'root' LIMIT 1`)
      .get(decision_id) as { decision_json: string } | undefined;

    return row ? (JSON.parse(row.decision_json) as Decision) : null;
  }

  async appendEvent(
    decision_id: string,
    input: Omit<DecisionEventRecord, "decision_id" | "seq">
  ): Promise<DecisionEventRecord> {
    const nextSeqRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM decision_events WHERE decision_id = ?`
      )
      .get(decision_id) as { next_seq: number };

    const rec: DecisionEventRecord = {
      decision_id,
      seq: nextSeqRow.next_seq,
      at: input.at,
      event: input.event,
    };

    this.db
      .prepare(
        `INSERT INTO decision_events(decision_id, seq, at, event_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(rec.decision_id, rec.seq, rec.at, JSON.stringify(rec.event));

    return rec;
  }

  async listEvents(decision_id: string): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json
         FROM decision_events
         WHERE decision_id = ?
         ORDER BY seq ASC`
      )
      .all(decision_id) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
    }>;

    return rows.map((r) => ({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.event_json) as DecisionEvent,
    }));
  }

  // Optional fast delta reader for snapshots:
  async listEventsFrom(decision_id: string, after_seq: number): Promise<DecisionEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT decision_id, seq, at, event_json
         FROM decision_events
         WHERE decision_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(decision_id, after_seq) as Array<{
      decision_id: string;
      seq: number;
      at: string;
      event_json: string;
    }>;

    return rows.map((r) => ({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.event_json) as DecisionEvent,
    }));
  }
}

// ---- simple in-memory snapshot store for the example ----
class InMemorySnapshotStore implements DecisionSnapshotStore {
  private snaps = new Map<string, DecisionSnapshot[]>();

  count(decision_id: string): number {
    return (this.snaps.get(decision_id) ?? []).length;
  }

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    const arr = this.snaps.get(decision_id) ?? [];
    if (!arr.length) return null;

    // IMPORTANT: return a deep clone so replay can't mutate stored snapshot
    return JSON.parse(JSON.stringify(arr[arr.length - 1]!)) as DecisionSnapshot;
  }

  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
    // IMPORTANT: store a deep clone so later code can't mutate it
    const snapCopy = JSON.parse(JSON.stringify(snapshot)) as DecisionSnapshot;

    const arr = this.snaps.get(snapCopy.decision_id) ?? [];
    const idx = arr.findIndex((s) => s.up_to_seq === snapCopy.up_to_seq);
    if (idx >= 0) arr[idx] = snapCopy;
    else arr.push(snapCopy);

    arr.sort((a, b) => a.up_to_seq - b.up_to_seq);
    this.snaps.set(snapCopy.decision_id, arr);
  }

  async pruneSnapshots(decision_id: string, keep_last_n: number): Promise<{ deleted: number }> {
    const arr = this.snaps.get(decision_id) ?? [];
    if (keep_last_n <= 0) {
      this.snaps.set(decision_id, []);
      return { deleted: arr.length };
    }
    if (arr.length <= keep_last_n) return { deleted: 0 };

    const keep = arr.slice(-keep_last_n);
    const deleted = arr.length - keep.length;
    this.snaps.set(decision_id, keep);
    return { deleted };
  }

  // in-memory snapshot store can’t prune DB events; no-op is fine for this demo
  async pruneEventsUpToSeq(_decision_id: string, _up_to_seq: number): Promise<{ deleted: number }> {
    return { deleted: 0 };
  }
}

// ---- demo ----
async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const snapshotStore = new InMemorySnapshotStore();

  const snapshotPolicy: SnapshotPolicy = { every_n_events: 2 };

  // ✅ V6 retention policy (what you asked about)
  const snapshotRetentionPolicy = {
    keep_last_n_snapshots: 2,
    prune_events_up_to_latest_snapshot: true,
  };

  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_sqlite_001";

  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: {
        title: "SQLite Demo Decision",
        owner_id: "system",
        source: "sqlite-demo",
      },
      event: { type: "VALIDATE", actor_id: "system" },
      snapshotStore,
      snapshotPolicy,
      snapshotRetentionPolicy,
    },
    opts
  );
  assertOk(r1, "validate");

  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      snapshotStore,
      snapshotPolicy,
      snapshotRetentionPolicy,
    },
    opts
  );
  assertOk(r2, "simulate");

  // add some events so we create multiple snapshots + trigger retention
  for (let i = 0; i < 8; i++) {
    const r = await applyEventWithStore(
      store,
      {
        decision_id,
        event: {
          type: "ATTACH_ARTIFACTS",
          actor_id: "system",
          artifacts: { extra: { tick: i } },
        },
        snapshotStore,
        snapshotPolicy,
        snapshotRetentionPolicy,
      },
      opts
    );
    assertOk(r, `tick ${i}`);
  }

  const current = await store.getDecision(decision_id);
  assert(current, "missing current decision"); // narrows to non-null

  const snap = await snapshotStore.getLatestSnapshot(decision_id);

  console.log(
    JSON.stringify(
      {
        decision_id: current.decision_id,
        state: current.state,
        history_len: current.history?.length ?? 0,
        snapshot_up_to_seq: snap?.up_to_seq ?? null,
        snapshots_kept_in_memory: snapshotStore.count(decision_id),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

