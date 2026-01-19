import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";

async function main() {
  const ledger = new SqliteDecisionLedgerStore(":memory:");

  // demo: create a few entries (replace with your real DB path)
  await ledger.appendLedgerEntry({
    at: "2025-01-01T00:00:00.000Z",
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 1,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: {
      event_type: "VALIDATE",
      idempotency_key: "v1",

      responsibility: { owner_id: "ORG_FINANCE", owner_role: "CFO", org_id: "ACME" },
      impact: { estimated_cost: 120000, currency: "USD", risk_score: 0.73, regulatory_exposure: "HIGH" },
    },
  });

  await ledger.appendLedgerEntry({
    at: "2025-01-01T00:00:00.050Z",
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 2,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: {
      event_type: "ATTACH_ARTIFACTS",
      idempotency_key: "a1",
      responsibility: { owner_id: "USER_123", owner_role: "ANALYST", org_id: "ACME" },
    },
  });

  // Proof bundle export: full ledger + verify report
  const entries = await ledger.listLedgerEntries({ limit: 1_000_000 });
  const report = await ledger.verifyLedger({ require_signatures: false });

  const bundle = {
    kind: "VERITASCALE_PROOF_BUNDLE_V12",
    generated_at: new Date().toISOString(),
    from_seq: entries.length ? entries[0]!.seq : null,
    to_seq: entries.length ? entries[entries.length - 1]!.seq : null,
    verify_report: report,
    ledger_entries: entries,
  };

  console.log(JSON.stringify(bundle, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


