// examples/run-decision-ledger-key-rotation.ts
import crypto from "node:crypto";
import { SqliteDecisionLedgerStore } from "../packages/decision/src/sqlite-ledger-store.js";
import {
  createHmacSigner,
  createHmacVerifier,
  createEd25519Signer,
  createEd25519Verifier,
  type LedgerSigAlg,
  type LedgerVerifier,
} from "../packages/decision/src/ledger-signing.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 50;
    return iso;
  };
}

// very small “tenant key store” (mediocre v1)
type TenantKey =
  | { tenant_id: string; alg: "HMAC_SHA256"; key_id: string; secret: string }
  | { tenant_id: string; alg: "ED25519"; key_id: string; public_key_pem: string };

class InMemoryTenantLedgerKeyStore {
  constructor(private keys: TenantKey[]) {}

  getVerifier(tenant_id: string, alg: LedgerSigAlg, key_id: string): LedgerVerifier | null {
    const k = this.keys.find((x) => x.tenant_id === tenant_id && x.alg === alg && x.key_id === key_id);
    if (!k) return null;

    if (k.alg === "HMAC_SHA256") {
      return createHmacVerifier({ secret: k.secret, key_id: k.key_id });
    }

    // ED25519
    return createEd25519Verifier(k.public_key_pem, k.key_id);
  }
}

async function main() {
  const ledger = new SqliteDecisionLedgerStore(":memory:");
  const now = makeDeterministicNow();

  // generate ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  // key store knows both keys (rotation)
  const keyStore = new InMemoryTenantLedgerKeyStore([
    { tenant_id: "TENANT_A", alg: "HMAC_SHA256", key_id: "k1", secret: "secret_v1" },
    { tenant_id: "TENANT_A", alg: "ED25519", key_id: "k2", public_key_pem: pubPem },
  ]);

  // 1) write with HMAC key k1
  const s1 = createHmacSigner({ key_id: "k1", secret: "secret_v1" });
  await ledger.appendLedgerEntry({
    at: now(),
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 1,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "VALIDATE", idempotency_key: "v1" },
    signer: s1,
  });

  // 2) rotate -> write with ED25519 key k2
  const s2 = createEd25519Signer(privPem, "k2");
  await ledger.appendLedgerEntry({
    at: now(),
    tenant_id: "TENANT_A",
    type: "DECISION_EVENT_APPENDED",
    decision_id: "dec_A",
    event_seq: 2,
    snapshot_up_to_seq: null,
    anchor_seq: null,
    payload: { event_type: "ATTACH_ARTIFACTS", idempotency_key: "a1" },
    signer: s2,
  });

  // verify: require signatures + resolve verifier per entry
  const report = await ledger.verifyLedger({
    require_signatures: true,
    resolveVerifier: (e) => {
      if (!e.tenant_id || !e.sig_alg || !e.key_id) return null;
      return keyStore.getVerifier(e.tenant_id, e.sig_alg, e.key_id);
    },
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});









