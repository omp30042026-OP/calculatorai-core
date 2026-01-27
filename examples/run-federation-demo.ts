import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";
import { FederationStore } from "../packages/decision/src/federation.js";
import { createHmacSigner, createHmacVerifier } from "../packages/decision/src/ledger-signing.js";

async function main() {
  const fs = await import("fs");
  try { fs.rmSync("replay-demo.db"); } catch {}
  // persistent file so you can show it
  const ledger = new SqliteDecisionLedgerStore("replay-demo.db", {
    policy: { require_signatures_for_types: ["FEDERATION_EVENT_PROPOSED" as any, "FEDERATION_EVENT_COSIGNED" as any] },
  });

  const fed = new FederationStore(ledger);

  // tenant keys (demo)
  const signerA = createHmacSigner({ key_id: "K_TENANT_A_V1", secret: "secret-A" });
  const signerB = createHmacSigner({ key_id: "K_TENANT_B_V1", secret: "secret-B" });

  const verifierA = createHmacVerifier({ key_id: "K_TENANT_A_V1", secret: "secret-A" });
  const verifierB = createHmacVerifier({ key_id: "K_TENANT_B_V1", secret: "secret-B" });

  const federation_id = "FED_CHARGEBACK_001";

  // 1) Org A proposes (signed)
  const proposed = await fed.createFederationEvent({
    federation_id,
    at: new Date().toISOString(),
    purpose: "CHARGEBACK_EVIDENCE",
    tenant_a: "TENANT_A",
    tenant_b: "TENANT_B",
    payload: {
      chargeback_id: "CB_7781",
      amount: 129.99,
      currency: "USD",
      merchant_claim: "DELIVERED",
      evidence: { delivery_scan: "proof://scan/abc", gps: "proof://gps/xyz" },
    },
    signerA,
  });

  console.log("\n1) PROPOSED (A signed):");
  console.log(JSON.stringify(proposed, null, 2));

  // 2) Org B co-signs (signed)
  const cosigned = await fed.cosignFederationEvent({
    federation_id,
    tenant_b: "TENANT_B",
    signerB,
  });

  console.log("\n2) CO-SIGNED (B signed):");
  console.log(JSON.stringify(cosigned, null, 2));

  // 3) Challenge -> dispute freeze
  const disputed = await fed.challengeFederationEvent({
    federation_id,
    by_tenant: "TENANT_A",
    reason: "Customer claims non-delivery; request arbitration.",
    at: new Date().toISOString(),
  });

  console.log("\n3) DISPUTED (frozen):");
  console.log(JSON.stringify(disputed, null, 2));

  // 4) Export proof bundle
  const bundle = await fed.exportFederationProofBundle(federation_id);
  console.log("\n4) PROOF BUNDLE:");
 const bundleJson = JSON.stringify(bundle, null, 2);
 console.log(bundleJson);
 const fs2 = await import("fs");
 fs2.writeFileSync("federation-proof-bundle.json", bundleJson);
 console.log("\nSaved: federation-proof-bundle.json");

  // 5) Offline verify bundle
  const verify = fed.verifyFederationBundle(bundle, {
    resolveVerifier: ({ tenant_id, key_id }) => {
      if (tenant_id === "TENANT_A" && key_id === "K_TENANT_A_V1") return verifierA;
      if (tenant_id === "TENANT_B" && key_id === "K_TENANT_B_V1") return verifierB;
      return null;
    },
  });

  console.log("\n5) VERIFY BUNDLE REPORT:");
  console.log(JSON.stringify(verify, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
