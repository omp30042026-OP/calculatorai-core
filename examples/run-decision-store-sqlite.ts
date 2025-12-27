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

// ---- tiny assert helper ----
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
class SqliteDecisionStore implements DecisionStore {
  private db: Database.Database;

  constructor(filename = ":memory:") {
    this.db = new Database(filename);
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
  private latest = new Map<string, DecisionSnapshot>();

  async getLatestSnapshot(decision_id: string): Promise<DecisionSnapshot | null> {
    return this.latest.get(decision_id) ?? null;
  }

  async putSnapshot(snapshot: DecisionSnapshot): Promise<void> {
    const cur = this.latest.get(snapshot.decision_id);
    if (!cur || snapshot.up_to_seq >= cur.up_to_seq) {
      this.latest.set(snapshot.decision_id, snapshot);
    }
  }
}

// ---- demo ----
async function main() {
  const store = new SqliteDecisionStore(":memory:"); // ✅ clean per run (best for npm run check)
  const snapshotStore = new InMemorySnapshotStore();
  const snapshotPolicy: SnapshotPolicy = { every_n_events: 2 };

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
    },
    opts
  );
  assert(r1.ok, "validate failed");

  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "system" },
      snapshotStore,
      snapshotPolicy,
    },
    opts
  );
  assert(r2.ok, "simulate failed");

  const r3 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        artifacts: {
          explain_tree_id: "tree_sql_001",
          extra: {
            simulation_snapshot_id: "snap_sql_001",
            note: "stored in sqlite",
          },
        },
      },
      snapshotStore,
      snapshotPolicy,
    },
    opts
  );
  assert(r3.ok, "attach artifacts failed");

  const current = await store.getDecision(decision_id);
  assert(current, "missing current decision");

  const snap = await snapshotStore.getLatestSnapshot(decision_id);

  console.log(
    JSON.stringify(
      {
        decision_id: current.decision_id,
        state: current.state,
        artifacts: current.artifacts ?? null,
        history_len: current.history?.length ?? 0,
        snapshot_up_to_seq: snap?.up_to_seq ?? null,
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

