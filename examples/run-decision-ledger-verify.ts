// examples/run-decision-ledger-verify.ts
import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";
import { createHmacSigner, createHmacVerifier } from "../packages/decision/src/ledger-signing.js";

async function main() {
  // -------------------------
  // CASE 1: Unsigned -> should FAIL when require_signatures=true
  // -------------------------
  {
    const ledger = new SqliteDecisionLedgerStore(":memory:");

    await ledger.appendLedgerEntry({
      at: "2025-01-01T00:00:00.000Z",
      tenant_id: "TENANT_A",
      type: "DECISION_EVENT_APPENDED",
      decision_id: "dec_A",
      event_seq: 1,
      payload: { event_type: "VALIDATE", idempotency_key: "v1" },
      // signer: undefined (unsigned)
    } as any);

    await ledger.appendLedgerEntry({
      at: "2025-01-01T00:00:00.050Z",
      tenant_id: "TENANT_B",
      type: "DECISION_EVENT_APPENDED",
      decision_id: "dec_B",
      event_seq: 1,
      payload: { event_type: "VALIDATE", idempotency_key: "v1" },
      // signer: undefined (unsigned)
    } as any);

    const verifyUnsigned = await ledger.verifyLedger({
      require_signatures: true,
      resolveVerifier: () => null, // doesn't matter; there are no sigs
    });

    console.log("\n--- verifyUnsigned (expect FAIL) ---");
    console.log(JSON.stringify(verifyUnsigned, null, 2));
  }

  // -------------------------
  // CASE 2: Signed -> should PASS when require_signatures=true
  // -------------------------
  {
    const ledger = new SqliteDecisionLedgerStore(":memory:");

    // signer/verifier for each tenant (demo secrets)
    const signerA = createHmacSigner({ key_id: "K_TENANT_A_V1", secret: "secret-A" });
    const signerB = createHmacSigner({ key_id: "K_TENANT_B_V1", secret: "secret-B" });

    const verifierA = createHmacVerifier({ key_id: "K_TENANT_A_V1", secret: "secret-A" });
    const verifierB = createHmacVerifier({ key_id: "K_TENANT_B_V1", secret: "secret-B" });

    await ledger.appendLedgerEntry({
      at: "2025-01-01T00:00:00.000Z",
      tenant_id: "TENANT_A",
      type: "DECISION_EVENT_APPENDED",
      decision_id: "dec_A",
      event_seq: 1,
      payload: { event_type: "VALIDATE", idempotency_key: "v1" },
      signer: signerA,
    } as any);

    await ledger.appendLedgerEntry({
      at: "2025-01-01T00:00:00.050Z",
      tenant_id: "TENANT_B",
      type: "DECISION_EVENT_APPENDED",
      decision_id: "dec_B",
      event_seq: 1,
      payload: { event_type: "VALIDATE", idempotency_key: "v1" },
      signer: signerB,
    } as any);

    const verifySigned = await ledger.verifyLedger({
      require_signatures: true,
      resolveVerifier: (e) => {
        if (e.tenant_id === "TENANT_A" && e.key_id === "K_TENANT_A_V1") return verifierA;
        if (e.tenant_id === "TENANT_B" && e.key_id === "K_TENANT_B_V1") return verifierB;
        return null;
      },
    });

    console.log("\n--- verifySigned (expect PASS) ---");
    console.log(JSON.stringify(verifySigned, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


