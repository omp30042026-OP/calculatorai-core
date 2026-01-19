// packages/decision/src/attestation.ts
import crypto from "node:crypto";
import type { Decision } from "./decision.js";

export type AttestationTarget = "DECISION_STATE" | "SNAPSHOT" | "ANCHOR";

export type AttestationPayload = {
  version: 1;

  decision_id: string;
  // Optional: snapshot seq if you're attesting a snapshot boundary
  snapshot_up_to_seq?: number;

  // What we're attesting (hashes must be stable)
  state_hash: string;

  // Optional: if you already compute merkle/anchor roots
  root_hash?: string;
  checkpoint_hash?: string;

  target: AttestationTarget;

  // When attested (engine/store provides time)
  attested_at: string;

  // Any provider-specific tags (region, environment, tenant, etc.)
  tags?: Record<string, string>;
};

export type AttestationReceipt = {
  provider: string;                 // e.g. "OpenTimestamps", "AWS-QTSA", "Ethereum", "CUSTOM"
  receipt_id?: string;              // provider id
  proof?: string;                   // base64/hex/JSON proof blob
  url?: string;                     // optional verification link
  tx_id?: string;                   // blockchain tx if applicable
  created_at: string;               // ISO
  payload_hash: string;             // sha256(payload_canonical_json)
};

export type Attestor = {
  provider: string;
  attest(payload: AttestationPayload): Promise<AttestationReceipt>;
};

// -----------------------------
// Helpers
// -----------------------------
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: any): any => {
    if (v === null) return null;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function computePayloadHash(payload: AttestationPayload): string {
  return sha256Hex(stableStringify(payload));
}

/**
 * Convenience: build a basic payload from a decision state-hash.
 * You can pass snapshot seq / root hashes from your snapshot/anchor layer later.
 */
export function buildDecisionAttestationPayload(params: {
  decision: Decision;
  state_hash: string;
  attested_at: string;
  target?: AttestationTarget;
  snapshot_up_to_seq?: number;
  root_hash?: string;
  checkpoint_hash?: string;
  tags?: Record<string, string>;
}): AttestationPayload {
  return {
    version: 1,
    decision_id: params.decision.decision_id,
    snapshot_up_to_seq: params.snapshot_up_to_seq,
    state_hash: params.state_hash,
    root_hash: params.root_hash,
    checkpoint_hash: params.checkpoint_hash,
    target: params.target ?? "DECISION_STATE",
    attested_at: params.attested_at,
    tags: params.tags,
  };
}

