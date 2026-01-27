import Database from "better-sqlite3";

// IMPORTANT: use JS import path because your repo is ESM transpiled by tsx
import { replayDecision } from "../packages/decision/src/engine.js";
import { createDecisionV2 } from "../packages/decision/src/decision.js";
import {
  applyProvenanceTransition,
  migrateProvenanceChain,
} from "../packages/decision/src/provenance.js";


import {
  computeTamperStateHash,
  computePublicStateHash,
} from "../packages/decision/src/state-hash.js";

type DecisionRow = { decision_json: string | null };
type ReceiptRow = {
  event_seq: number;
  event_type: string;
  state_after_hash: string | null;
  public_state_after_hash: string | null;
};
type StatsRow = {
  total: number;
  public_equals_tamper: number;
  public_differs: number;
  public_null: number;
};

function canonicalDraftRootFromStored(root: any): any {
  const created_at = root?.created_at ?? "1970-01-01T00:00:00.000Z";
  const nowFn = () => created_at;

  const d = createDecisionV2(
    {
      decision_id: root.decision_id,
      meta: root.meta ?? {},
      artifacts: {}, // important: genesis clean
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at };
}

function nowIso(): string {
  return new Date().toISOString();
}

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]);
  return fallback;
}

function main() {
  const dbPath = argValue("--db", "replay-demo.db");
  const decisionId = argValue("--decision", "dec_exec_001");

  console.log("db =", dbPath);
  console.log("decision =", decisionId);

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
      `SELECT seq, event_json
       FROM decision_events
       WHERE decision_id=?
       ORDER BY seq`
    )
    .all(decisionId)
    .map((r: any) => ({ seq: Number(r.seq), event: JSON.parse(r.event_json) }));

  console.log("events =", events.length);

  const base = canonicalDraftRootFromStored(root);
  let head = base;

  const update = db.prepare(`
    UPDATE liability_receipts
    SET
      state_after_hash=?,
      public_state_after_hash=?
    WHERE decision_id=? AND event_seq=?
  `);

  const getReceipt = db.prepare(`
    SELECT event_seq, event_type, state_after_hash, public_state_after_hash
    FROM liability_receipts
    WHERE decision_id=? AND event_seq=?
  `);

  const allowLocked = ["ATTACH_ARTIFACTS", "INGEST_RECORDS", "ATTEST_EXTERNAL"];

  db.transaction(() => {
    for (const { seq, event } of events) {
      // ✅ Incremental replay: apply ONLY this event on current head
      const rr = replayDecision(head, [event], {
        allow_locked_event_types: allowLocked,
      } as any);

      if (rr.ok === false) {
        throw new Error(
          `Replay failed at seq=${seq}: ${rr.violations?.[0]?.code ?? "REPLAY_FAILED"}`
        );
      }

      const before = migrateProvenanceChain(head);
      const after = migrateProvenanceChain(rr.decision);

      const withProv = applyProvenanceTransition({
        before,
        after,
        event,
        event_type: event.type,
        nowIso: nowIso(),
      } as any);

      const tamper = computeTamperStateHash(withProv as any);
      const pub = computePublicStateHash(withProv as any);

      const prev = getReceipt.get(decisionId, seq) as ReceiptRow | undefined;

      console.log(
        `seq ${seq} ${String(prev?.event_type ?? "").padEnd(18)} old(after)=${String(
          prev?.state_after_hash ?? ""
        ).slice(0, 12)} new(after)=${tamper.slice(0, 12)} new(pub)=${pub.slice(
          0,
          12
        )}`
      );

      update.run(tamper, pub, decisionId, seq);

      // move head forward
      head = withProv as any;
    }
  })();

  console.log("✅ migration complete");

  const stats = db
    .prepare(
      `
    SELECT
      COUNT(*) AS total,
      SUM(public_state_after_hash = state_after_hash) AS public_equals_tamper,
      SUM(public_state_after_hash != state_after_hash) AS public_differs,
      SUM(public_state_after_hash IS NULL) AS public_null
    FROM liability_receipts
    WHERE decision_id=?
  `
    )
    .get(decisionId) as StatsRow;

  console.log("post-migration stats:", stats);
}

main();