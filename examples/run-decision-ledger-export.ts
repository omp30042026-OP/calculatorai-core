import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";

async function main() {
  const ledger = new SqliteDecisionLedgerStore(":memory:");

  await ledger.appendLedgerEntry({
    at: "2025-01-01T00:00:00.000Z",
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 1,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "VALIDATE", idempotency_key: "v1" },
  } as any);

  await ledger.appendLedgerEntry({
    at: "2025-01-01T00:00:00.050Z",
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 2,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "ATTACH_ARTIFACTS", idempotency_key: "a1" },
  } as any);

  const range = await ledger.exportLedgerRange({ from_seq: 1, to_seq: 2 });
  console.log("export_range_count:", range.length);
  console.log(range);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

