import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 50;
    return iso;
  };
}

async function main() {
  const ledger = new SqliteDecisionLedgerStore(":memory:");
  const now = makeDeterministicNow();

  await ledger.appendLedgerEntry({
    at: now(),
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 1,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "VALIDATE", idempotency_key: "v1" },
  });

  await ledger.appendLedgerEntry({
    at: now(),
    tenant_id: "TENANT_B",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_B",
    event_seq: 1,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "VALIDATE", idempotency_key: "v1" },
  });

  const all = await ledger.listLedgerEntries({ limit: 50 });
  console.log("ledger_count:", all.length);
  console.log(all);

  const onlyA = await ledger.listLedgerEntries({ tenant_id: "TENANT_A", limit: 50 });
  console.log("tenant_A_count:", onlyA.length);

  const exportRange = await ledger.exportLedgerRange({ from_seq: 1, to_seq: 2 });
  console.log("export_range_count:", exportRange.length);

  const verify = await ledger.verifyLedger();
  console.log(JSON.stringify(verify, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


