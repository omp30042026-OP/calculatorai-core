// examples/run-decision-attestation.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import type { Attestor, AttestationPayload, AttestationReceipt } from "../packages/decision/src/attestation.js";
import { computePayloadHash } from "../packages/decision/src/attestation.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 5;
    return iso;
  };
}

// Dummy attestor (replace with real provider later)
const DemoAttestor: Attestor = {
  provider: "DEMO_NOTARY",
  async attest(payload: AttestationPayload): Promise<AttestationReceipt> {
    const payload_hash = computePayloadHash(payload);
    return {
      provider: "DEMO_NOTARY",
      receipt_id: "rcpt_" + payload_hash.slice(0, 12),
      proof: JSON.stringify({ ok: true, payload_hash }),
      url: "https://example.com/verify/" + payload_hash,
      created_at: payload.attested_at,
      payload_hash,
    };
  },
};

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_attest_001";

  const validate = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Attestation Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
    },
    opts
  );

  const attest = await applyEventWithStore(
    store,
    {
      decision_id,
      attestor: DemoAttestor,
      event: {
        type: "ATTEST_EXTERNAL",
        actor_id: "alice",
        target: "DECISION_STATE",
        tags: { env: "demo" },
      } as any,
      idempotency_key: "att1",
    },
    opts
  );

  process.stdout.write(JSON.stringify({ validate, attest }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


