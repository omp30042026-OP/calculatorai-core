import path from "node:path";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store";
import { applyEventWithStore } from "../packages/decision/src/store-engine";

function parseArgs(argv: string[]) {
  let dbPath = "replay-demo.db";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db" && typeof argv[i + 1] === "string") {
      const next = argv[i + 1];
      if (typeof next === "string") dbPath = next;
      i++;
    }
  }
  return { dbPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const absDb = path.resolve(process.cwd(), args.dbPath);
  const store = new SqliteDecisionStore(absDb);

  const r = await applyEventWithStore(
    store as any,
    {
      decision_id: "dec_exec_001",
      event: { type: "SIMULATE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "simulate_once",
    },
    {}
  );

  if (!r.ok) {
    console.log("BLOCKED:", JSON.stringify(r.violations, null, 2));
    process.exit(1);
  }
  console.log("OK:", r.decision.state);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

