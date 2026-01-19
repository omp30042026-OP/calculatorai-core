// examples/run-decision-ledger.ts
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { computeLedgerEntryHash } from "../packages/decision/src/ledger.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 50;
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();

  const decision_id = "dec_ledger_001";

  // ✅ Force snapshots + anchors so you will see SNAPSHOT_CREATED and ANCHOR_APPENDED in the ledger
  const snapshotStore = store;
  const snapshotPolicy = { every_n_events: 1 } as any; // create a snapshot after every event
  const anchorStore = store;
  const anchorPolicy = { enabled: true } as any; // create anchor whenever snapshot created

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Ledger Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" } as any,
      idempotency_key: "v1",

      // ✅ enable snapshots + anchors
      snapshotStore,
      snapshotPolicy,
      anchorStore,
      anchorPolicy,

      // ✅ Feature 12 fields (2B)
      responsibility: {
        owner_id: "team_risk",
        owner_role: "RISK_OWNER",
        org_id: "org_demo",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_to: null,
      },
      approver: {
        approver_id: "bob",
        approver_role: "MANAGER",
      },
      impact: {
        estimated_cost: 1200,
        currency: "USD",
        risk_score: 7,
        regulatory_exposure: "MEDIUM",
        notes: "Demo: moderate risk + small cost impact",
      },
    },
    { now }
  );

  await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "alice",
        artifacts: { extra: { note: "hello" } },
      } as any,
      idempotency_key: "a1",

      // ✅ enable snapshots + anchors
      snapshotStore,
      snapshotPolicy,
      anchorStore,
      anchorPolicy,

      // ✅ Feature 12 fields (2B) - can vary per event
      responsibility: {
        owner_id: "team_risk",
        owner_role: "RISK_OWNER",
        org_id: "org_demo",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_to: null,
      },
      approver: {
        approver_id: "carol",
        approver_role: "DIRECTOR",
      },
      impact: {
        estimated_cost: 350,
        currency: "USD",
        risk_score: 4,
        regulatory_exposure: "LOW",
        notes: "Attaching evidence reduces risk",
      },
    },
    { now }
  );

  const all = await store.listLedgerEntries(200);
  console.log("ledger_count:", all.length);
  console.log(JSON.stringify(all, null, 2));

  // manual verify (demo)
  let prev: string | null = null;
  const errors: any[] = [];

  for (const e of all) {
    const expected: string = computeLedgerEntryHash({
      seq: e.seq,
      at: e.at,
      tenant_id: e.tenant_id ?? null,
      type: e.type,
      decision_id: e.decision_id ?? null,
      event_seq: e.event_seq ?? null,
      snapshot_up_to_seq: e.snapshot_up_to_seq ?? null,
      anchor_seq: e.anchor_seq ?? null,
      payload: e.payload ?? null,
      prev_hash: prev,
    });

    if (e.prev_hash !== prev || e.hash !== expected) {
      errors.push({
        seq: e.seq,
        expected_hash: expected,
        stored_hash: e.hash,
        stored_prev_hash: e.prev_hash,
        computed_prev_hash: prev,
      });
    }

    prev = expected;
  }

  console.log(
    JSON.stringify(
      { ledger_verified: errors.length === 0, ledger_errors: errors },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


