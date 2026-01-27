import { FederationStore } from "../packages/decision/src/federation.js";
import { createHmacVerifier } from "../packages/decision/src/ledger-signing.js";

async function main() {
  const fs = await import("fs");

  const path = process.argv[2] ?? "federation-proof-bundle.json";
  const raw = fs.readFileSync(path, "utf-8");
  const bundle = JSON.parse(raw);

  // Demo verifiers (same as demo)
  const verifierA = createHmacVerifier({ key_id: "K_TENANT_A_V1", secret: "secret-A" });
  const verifierB = createHmacVerifier({ key_id: "K_TENANT_B_V1", secret: "secret-B" });

  // We don't need a DB for verification; we just need the verify function.
  // So we instantiate a dummy object and call verifyFederationBundle on it.
  const dummy: any = { verifyFederationBundle: FederationStore.prototype.verifyFederationBundle };
  const verify = dummy.verifyFederationBundle(bundle, {
    resolveVerifier: ({ tenant_id, key_id }: any) => {
      if (tenant_id === "TENANT_A" && key_id === "K_TENANT_A_V1") return verifierA;
      if (tenant_id === "TENANT_B" && key_id === "K_TENANT_B_V1") return verifierB;
      return null;
    },
  });

  console.log(JSON.stringify(verify, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
