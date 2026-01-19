// examples/run-decision-ledger-signed.ts
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import {
  createHmacSigner,
  createHmacVerifier,
} from "../packages/decision/src/ledger-signing.js";

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

  // one tenant + one key for demo
  const tenant_id = "TENANT_A";
  const key_id = "K_TENANT_A_V1";
  const secret = "dev-secret-123";

  const signer = createHmacSigner({ key_id, secret });
  const verifier = createHmacVerifier({ key_id, secret });

  const decision_id = "dec_signed_001";

  await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Signed Ledger Demo", owner_id: "system" },
      event: { type: "VALIDATE", actor_id: "alice" } as any,
      idempotency_key: "v1",

      // ✅ IMPORTANT: this is what actually signs the ledger writes
      tenant_id,
      ledgerSigner: signer,
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
        artifacts: { extra: { x: 1 } },
      } as any,
      idempotency_key: "a1",

      // ✅ IMPORTANT: sign again for subsequent ledger entries
      tenant_id,
      ledgerSigner: signer,
    },
    { now }
  );

  // (optional) show ledger
  const all = await store.listLedgerEntries({ tenant_id, limit: 50 });
  console.log("ledger_count:", all.length);
  console.log(JSON.stringify(all, null, 2));

  // ✅ STRICT verify: requires signatures + verifies using our resolver
  const report = await store.verifyLedger({
    require_signatures: true,
    resolveVerifier: (entry) => {
      // for multi-tenant, you’d map tenant_id -> correct verifier here
      if (entry.key_id === key_id) return verifier;
      return null;
    },
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

