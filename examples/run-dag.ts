// examples/run-dag.ts
import Database from "better-sqlite3";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { ensureEnterpriseTables } from "../packages/decision/src/enterprise-schema.js";

function nowGen() {
  // deterministic-ish for tests
  return new Date().toISOString();
}

function readArg(args: string[], key: string, fallback?: string) {
  const i = args.indexOf(key);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v ?? fallback;
}

function hasFlag(args: string[], key: string) {
  return args.includes(key);
}

async function main() {
  const args = process.argv.slice(2);

  const dbPath = readArg(args, "--db", "replay-demo.db")!;
  const reset = hasFlag(args, "--reset");

  if (reset) {
    // best-effort reset: delete file by opening+closing and relying on caller to rm -f
    // (keeping it simple—your shell already does rm -f in other demos)
  }

  // ✅ Ensure enterprise tables exist even if the engine isn't hit noticebly yet
  const rawDb = new Database(dbPath);
  ensureEnterpriseTables(rawDb);
  rawDb.close();

  // ✅ IMPORTANT: SqliteDecisionStore expects a FILEPATH (string), not a Database object
  const store = new SqliteDecisionStore(dbPath);

  const decision_id = "dec_exec_001";

  // Ensure primary decision exists
  await applyEventWithStore(
    store as any,
    {
      decision_id,
      event: { type: "VALIDATE", actor_id: "system", actor_type: "system" } as any,
    },
    { now: nowGen }
  );

  // Create a second decision so we can link to it (upstream)
  await applyEventWithStore(
    store as any,
    {
      decision_id: "dec_other_002",
      event: { type: "VALIDATE", actor_id: "system", actor_type: "system" } as any,
    },
    { now: nowGen }
  );

  // ✅ UPSTREAM edge: dec_exec_001 -> dec_other_002 (DERIVES_FROM)
  const r = await applyEventWithStore(
    store as any,
    {
      decision_id,
      event: {
        type: "LINK_DECISIONS",
        actor_id: "alice",
        actor_type: "human",
        links: [
          {
            to_decision_id: "dec_other_002",
            relation: "DERIVES_FROM",
            note: "This decision was derived from the other one",
            confidence: 0.92,
          },
        ],
      } as any,
    },
    { now: nowGen }
  );

  console.log("apply LINK_DECISIONS ok:", r.ok);

  // ✅✅✅ ADD: DOWNSTREAM edge by creating a child that depends on dec_exec_001
  // This creates: dec_child_003 -> dec_exec_001 (DEPENDS_ON)
  await applyEventWithStore(
    store as any,
    {
      decision_id: "dec_child_003",
      event: { type: "VALIDATE", actor_id: "system", actor_type: "system" } as any,
    },
    { now: nowGen }
  );

  const r2 = await applyEventWithStore(
    store as any,
    {
      decision_id: "dec_child_003",
      event: {
        type: "LINK_DECISIONS",
        actor_id: "bob",
        actor_type: "human",
        links: [
          {
            to_decision_id: "dec_exec_001",
            relation: "DEPENDS_ON",
            note: "child depends on exec",
            confidence: 0.91,
          },
        ],
      } as any,
    },
    { now: nowGen }
  );

  console.log("apply LINK_DECISIONS (child->exec) ok:", r2.ok);

  // Quick verify (optional): show edges if any were written by the engine
  try {
    const db = new Database(dbPath);
    const rows = db
      .prepare(
        `
        select id, from_decision_id, to_decision_id, relation, via_event_seq, edge_hash, created_at
        from decision_edges
        order by id;
      `
      )
      .all();
    db.close();

    console.log("decision_edges rows:", rows.length);
    if (rows.length) console.log(rows);
  } catch (e) {
    console.log("could not query decision_edges:", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

