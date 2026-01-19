import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { createHmacSigner, createHmacVerifier } from "../packages/decision/src/ledger-signing.js";
// import { verifyLedger } from "../packages/decision/src/ledger.js"; // wherever your verify lives

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

  const signer = createHmacSigner({ key_id: "k1", secret: "dev-secret-123" });
  const verifier = createHmacVerifier({ key_id: "k1", secret: "dev-secret-123" });

  // wherever you attach ledger signing in your store/ledger module:
  // e.g. store.setLedgerSigner?.(signer)
  // OR pass signer into applyEventWithStore input if that’s how you wired ledger writes.

  await applyEventWithStore(
    store,
    {
      decision_id: "dec_signed_001",
      metaIfCreate: { title: "Signed Ledger Demo", owner_id: "system" },
      event: { type: "VALIDATE", actor_id: "alice" } as any,
      idempotency_key: "v1",
      // ledgerSigner: signer,  // <-- use whichever pattern you used
    },
    { now }
  );

  await applyEventWithStore(
    store,
    {
      decision_id: "dec_signed_001",
      event: { type: "ATTACH_ARTIFACTS", actor_id: "alice", artifacts: { extra: { x: 1 } } } as any,
      idempotency_key: "a1",
      // ledgerSigner: signer,
    },
    { now }
  );

  // const report = await verifyLedger(store, { verifier });
  // console.log(report);

  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

