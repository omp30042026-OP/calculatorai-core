// packages/decision/src/external-attestations.ts
import crypto from "node:crypto";

export type ExternalAttestation = {
  attestation_id: string;
  decision_id: string;
  type: string; // e.g., "invoice_pdf", "bank_statement", "sensor_reading"
  content_hash: string; // sha256 of evidence bytes or canonical JSON
  signer: string; // who attested (org/user/device)
  signature?: string | null; // optional v1
  created_at: string;
  meta_json?: string | null;
};

export function computeContentHash(bytesOrString: Buffer | string) {
  const buf = typeof bytesOrString === "string" ? Buffer.from(bytesOrString) : bytesOrString;
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function makeAttestationId(input: {
  decision_id: string;
  type: string;
  content_hash: string;
  signer: string;
  created_at: string;
}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

