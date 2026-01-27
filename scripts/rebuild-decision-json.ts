import Database from "better-sqlite3";

// IMPORTANT: use JS import path because your repo is ESM transpiled by tsx
import { replayDecision } from "../packages/decision/src/engine.js";
import { createDecisionV2 } from "../packages/decision/src/decision.js";
import {
  applyProvenanceTransition,
  migrateProvenanceChain,
} from "../packages/decision/src/provenance.js";

function canonicalDraftRootFromStored(root: any): any {
  const created_at = root?.created_at ?? "1970-01-01T00:00:00.000Z";
  const nowFn = () => created_at;

  const d = createDecisionV2(
    {
      decision_id: root.decision_id,
      meta: root.meta ?? {},
      artifacts: {}, // genesis clean
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at };
}

function nowIso(): string {
  return new Date().toISOString();
}

type DecisionRow = { decision_json: string | null };

function main() {
  const dbPath = process.argv.includes("--db")
    ? process.argv[process.argv.indexOf("--db") + 1]
    : "replay-demo.db";

  const decisionId = process.argv.includes("--decision")
    ? process.argv[process.argv.indexOf("--decision") + 1]
    : "dec_exec_001";

  const db = new Database(dbPath);

  const rootRow = db
    .prepare(`SELECT decision_json FROM decisions WHERE decision_id=?`)
    .get(decisionId) as DecisionRow | undefined;

  if (!rootRow?.decision_json) {
    console.error("missing decisions.decision_json for", decisionId);
    process.exit(1);
  }

  const root = JSON.parse(rootRow.decision_json);

  const events = db
    .prepare(
      `SELECT seq, event_json FROM decision_events WHERE decision_id=? ORDER BY seq`
    )
    .all(decisionId)
    .map((r: any) => ({ seq: Number(r.seq), event: JSON.parse(r.event_json) }));

  console.log("db =", dbPath);
  console.log("decision =", decisionId);
  console.log("events =", events.length);

  const base = canonicalDraftRootFromStored(root);

  let head = base;

  // Rebuild sequentially so provenance transition is applied the same way store-engine does.
  for (const { seq } of events) {
    const rr = replayDecision(
      head,
      [events.find((e) => e.seq === seq)!.event],
      { allow_locked_event_types: ["ATTACH_ARTIFACTS", "INGEST_RECORDS", "ATTEST_EXTERNAL"] } as any
    );

    if (rr.ok === false) {
      throw new Error(
        `Replay failed at seq=${seq}: ${rr.violations?.[0]?.code ?? "REPLAY_FAILED"}`
      );
    }

    const before = migrateProvenanceChain(head);
    const after = migrateProvenanceChain(rr.decision);

    const lastEvent = events.find((e) => e.seq === seq)!.event;

    const withProv = applyProvenanceTransition({
      before,
      after,
      event: lastEvent,
      event_type: lastEvent.type,
      nowIso: nowIso(),
    } as any);

    head = withProv as any;
  }

  // Persist canonical head into decisions.decision_json
  const update = db.prepare(`
    UPDATE decisions
    SET decision_json=?
    WHERE decision_id=?
  `);

  update.run(JSON.stringify(head), decisionId);

  console.log("✅ decisions.decision_json rebuilt from events");
}

main();

