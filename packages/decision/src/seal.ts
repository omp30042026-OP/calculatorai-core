import * as crypto from "node:crypto";
import { stableStringify } from "./stable-json.js";
import { computePublicStateHash, computeTamperStateHash } from "./state-hash.js";

export type VeritascaleSignatureV1 = {
  kind: "VERITASCALE_SIGNATURE_V1";
  alg: "ed25519";
  key_id: string;
  actor_id: string | null;
  created_at: string;
  payload: {
    decision_id: string | null;
    public_state_hash: string;
    tamper_state_hash: string;
  };
  signature_b64: string;
  public_key_pem: string | null;
};

function keyFingerprintSha256(publicKeyPem: string): string {
  const pub = crypto.createPublicKey(publicKeyPem);
  const der = pub.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function buildSignable(sig: Omit<VeritascaleSignatureV1, "signature_b64" | "public_key_pem">): string {
  return stableStringify({
    kind: sig.kind,
    alg: sig.alg,
    key_id: sig.key_id,
    actor_id: sig.actor_id ?? null,
    created_at: sig.created_at,
    payload: sig.payload,
  });
}

/**
 * Seals a decision:
 * - deletes previously stored hashes (prevents self-hash drift)
 * - computes/stores hashes (public_state_hash + tamper_state_hash)
 * - writes exactly ONE signature (replaces existing signatures)
 *
 * Idempotent: sealing twice yields the same hashes and keeps signatures length at 1.
 */
export function sealDecision(params: {
  decision: any;
  privateKeyPem: string;
  actorId?: string | null;
  embedPub?: boolean;
  now?: () => string;
}): any {
  const { decision, privateKeyPem, actorId = null, embedPub = false, now = () => new Date().toISOString() } = params;

  if (!decision || typeof decision !== "object") {
    throw new Error("sealDecision: decision must be an object");
  }

  // ✅ Do NOT mutate caller: work on a deep clone (repo assumes JSON-safe objects)
  const d = JSON.parse(JSON.stringify(decision));

  // ✅ CRITICAL: remove previously stored hashes so we never hash stale values
  delete d.public_state_hash;
  delete d.tamper_state_hash;

  // (Optional belt-and-suspenders; hashing already strips signatures, but this avoids confusion)
  // delete d.signatures;

  // Compute hashes on the cleaned object
  const public_state_hash = computePublicStateHash(d);
  const tamper_state_hash = computeTamperStateHash(d);

  // Key material
  const priv = crypto.createPrivateKey(privateKeyPem);
  const pubPem = crypto.createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  const key_id = keyFingerprintSha256(pubPem);

  // Signature payload binds to the hashes
  const created_at = now();
  const payload = {
    decision_id: (d?.decision_id ?? d?.id ?? null) as string | null,
    public_state_hash,
    tamper_state_hash,
  };

  const base = {
    kind: "VERITASCALE_SIGNATURE_V1" as const,
    alg: "ed25519" as const,
    key_id,
    actor_id: actorId ?? null,
    created_at,
    payload,
  };

  const signable = buildSignable(base);
  const signature_b64 = crypto.sign(null, Buffer.from(signable, "utf8"), priv).toString("base64");

  const sig: VeritascaleSignatureV1 = {
    ...base,
    signature_b64,
    public_key_pem: embedPub ? pubPem : null,
  };

  // Store hashes + exactly one signature
  d.public_state_hash = public_state_hash;
  d.tamper_state_hash = tamper_state_hash;
  d.signatures = [sig];

  return d;
}

