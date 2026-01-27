import crypto from "node:crypto";
import type { PolicyViolation } from "./policy.js";
import type { DecisionEvent } from "./events.js";
import { computeTamperStateHash, stripNonStateFieldsForHash } from "./state-hash.js";
import type { Decision } from "./decision.js";

export type SignerBindingKind = "SIGNER_BINDING_V1";

export type SignerBindingPayloadV1 = {
  kind: SignerBindingKind;
  decision_id: string;
  event_type: string;

  // signer identity
  signer_id: string;

  // binds signer to the exact before-state
  signer_state_hash: string;

  // binds to the canonical event time used in engine
  at: string;

  // optional trust/context binding
  tenant_id?: string | null;
  origin_zone?: string | null;
  origin_system?: string | null;
  channel?: string | null;
};

export type SignerDirectory = {
  /**
   * Return PEM public key for signer_id (ed25519 or rsa). Null => unknown signer.
   */
  getSignerPublicKeyPem: (signer_id: string) => Promise<string | null>;
};

function stableStringify(value: unknown): string {
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

export function buildSignerBindingPayloadV1(params: {
  decision_id: string;
  event_type: string;
  signer_id: string;
  signer_state_hash: string;
  at: string;
  trust?: {
    tenant_id?: string | null;
    origin_zone?: string | null;
    origin_system?: string | null;
    channel?: string | null;
  } | null;
}): SignerBindingPayloadV1 {
  return {
    kind: "SIGNER_BINDING_V1",
    decision_id: params.decision_id,
    event_type: params.event_type,
    signer_id: params.signer_id,
    signer_state_hash: params.signer_state_hash,
    at: params.at,
    tenant_id: params.trust?.tenant_id ?? null,
    origin_zone: params.trust?.origin_zone ?? null,
    origin_system: params.trust?.origin_system ?? null,
    channel: params.trust?.channel ?? null,
  };
}

export function verifySignerBindingOrThrow(params: {
  decision_id: string;
  decision_before: Decision;
  event: DecisionEvent;
  eventAt: string;
  signerDirectory?: SignerDirectory;
}): PolicyViolation[] {
  const { decision_id, decision_before, event, eventAt, signerDirectory } = params;

  // Only finalize-like events get signer binding in v1
  const FINALIZE = new Set(["APPROVE", "REJECT", "PUBLISH"]);
  if (!FINALIZE.has(String((event as any)?.type ?? ""))) return [];

  const meta = ((event as any)?.meta ?? {}) as any;

  const signer_id = typeof meta.signer_id === "string" ? meta.signer_id : null;
  const signer_state_hash =
    typeof meta.signer_state_hash === "string" ? meta.signer_state_hash : null;

  const signature =
    typeof meta.signer_signature === "string" ? meta.signer_signature : null;

  const signature_alg =
    typeof meta.signer_signature_alg === "string"
      ? meta.signer_signature_alg
      : "ed25519";

  const violations: PolicyViolation[] = [];

  if (!signer_id) {
    violations.push({
      code: "SIGNER_ID_REQUIRED",
      severity: "BLOCK",
      message: "Signer binding required: meta.signer_id is missing.",
    });
  }

  if (!signer_state_hash) {
    violations.push({
      code: "SIGNER_STATE_HASH_REQUIRED",
      severity: "BLOCK",
      message: "Signer binding required: meta.signer_state_hash is missing.",
    });
  }

  if (!signature) {
    violations.push({
      code: "SIGNER_SIGNATURE_REQUIRED",
      severity: "BLOCK",
      message: "Signer binding required: meta.signer_signature is missing.",
    });
  }

  // Fail early if missing anything
  if (violations.length) return violations;

  // 1) Check signer_state_hash matches actual decision_before state (tamper hash)
  const expected_state_hash = computeTamperStateHash(
    stripNonStateFieldsForHash(decision_before as any)
  );

  if (String(signer_state_hash) !== String(expected_state_hash)) {
    return [
      {
        code: "SIGNER_STATE_HASH_MISMATCH",
        severity: "BLOCK",
        message:
          "Signer binding failed: meta.signer_state_hash does not match current decision state (before finalize).",
        details: { expected: expected_state_hash, provided: signer_state_hash } as any,
      },
    ];
  }

  // 2) Build canonical payload that must have been signed
  const trust = (event as any)?.trust?.origin
    ? {
        origin_zone: (event as any).trust.origin.zone ?? null,
        origin_system: (event as any).trust.origin.system ?? null,
        channel: (event as any).trust.origin.channel ?? null,
        tenant_id: (event as any).trust.origin.tenant_id ?? null,
      }
    : null;

  const payload = buildSignerBindingPayloadV1({
    decision_id,
    event_type: String((event as any).type),
    signer_id: String(signer_id),
    signer_state_hash: String(signer_state_hash),
    at: eventAt,
    trust,
  });

  const payload_json = stableStringify(payload);

  // 3) Verify signature (requires signerDirectory)
  if (!signerDirectory) {
    return [
      {
        code: "SIGNER_DIRECTORY_MISSING",
        severity: "BLOCK",
        message:
          "Signer binding requires signerDirectory to verify signature, but none was provided.",
      },
    ];
  }

  // NOTE: we keep this synchronous verification style simple
  // ed25519 verification expects a PEM key
  // signature is base64
  const sigBuf = Buffer.from(String(signature), "base64");

  // Load key later in engine where we can await; here we return a “needs async” error if used directly
  // (We will do the async version inside store-engine.)
  return [
    {
      code: "SIGNER_VERIFY_REQUIRES_ASYNC",
      severity: "BLOCK",
      message:
        "Signer binding verification must be performed in store-engine (async) so we can fetch signer public key.",
      details: { signer_id, signature_alg, payload_json_len: payload_json.length } as any,
    },
  ];
}

export async function verifySignerBindingAsync(params: {
  decision_id: string;
  decision_before: Decision;
  event: DecisionEvent;
  eventAt: string;
  signerDirectory: SignerDirectory;
}): Promise<PolicyViolation[]> {
  const { decision_id, decision_before, event, eventAt, signerDirectory } = params;

  const FINALIZE = new Set(["APPROVE", "REJECT", "PUBLISH"]);
  if (!FINALIZE.has(String((event as any)?.type ?? ""))) return [];

  const meta = ((event as any)?.meta ?? {}) as any;

  const signer_id = typeof meta.signer_id === "string" ? meta.signer_id : null;
  const signer_state_hash =
    typeof meta.signer_state_hash === "string" ? meta.signer_state_hash : null;

  const signature =
    typeof meta.signer_signature === "string" ? meta.signer_signature : null;

  const signature_alg =
    typeof meta.signer_signature_alg === "string"
      ? meta.signer_signature_alg
      : "ed25519";

  if (!signer_id || !signer_state_hash || !signature) {
    // keep error codes consistent with sync validator
    const out: PolicyViolation[] = [];
    if (!signer_id)
      out.push({ code: "SIGNER_ID_REQUIRED", severity: "BLOCK", message: "Signer binding required: meta.signer_id is missing." });
    if (!signer_state_hash)
      out.push({ code: "SIGNER_STATE_HASH_REQUIRED", severity: "BLOCK", message: "Signer binding required: meta.signer_state_hash is missing." });
    if (!signature)
      out.push({ code: "SIGNER_SIGNATURE_REQUIRED", severity: "BLOCK", message: "Signer binding required: meta.signer_signature is missing." });
    return out;
  }

  const expected_state_hash = computeTamperStateHash(
    stripNonStateFieldsForHash(decision_before as any)
  );

  if (String(signer_state_hash) !== String(expected_state_hash)) {
    return [
      {
        code: "SIGNER_STATE_HASH_MISMATCH",
        severity: "BLOCK",
        message:
          "Signer binding failed: meta.signer_state_hash does not match current decision state (before finalize).",
        details: { expected: expected_state_hash, provided: signer_state_hash } as any,
      },
    ];
  }

  const trust = (event as any)?.trust?.origin
    ? {
        origin_zone: (event as any).trust.origin.zone ?? null,
        origin_system: (event as any).trust.origin.system ?? null,
        channel: (event as any).trust.origin.channel ?? null,
        tenant_id: (event as any).trust.origin.tenant_id ?? null,
      }
    : null;

  const payload = buildSignerBindingPayloadV1({
    decision_id,
    event_type: String((event as any).type),
    signer_id: String(signer_id),
    signer_state_hash: String(signer_state_hash),
    at: eventAt,
    trust,
  });

  const payload_json = stableStringify(payload);

  const pubPem = await signerDirectory.getSignerPublicKeyPem(String(signer_id));
  if (!pubPem) {
    return [
      {
        code: "SIGNER_UNKNOWN",
        severity: "BLOCK",
        message: `Signer public key not found for signer_id='${String(signer_id)}'.`,
        details: { signer_id } as any,
      },
    ];
  }

  const sigBuf = Buffer.from(String(signature), "base64");

  let ok = false;
  try {
    if (String(signature_alg).toLowerCase() === "ed25519") {
      ok = crypto.verify(null, Buffer.from(payload_json, "utf8"), pubPem, sigBuf);
    } else {
      // RSA/ECDSA path (SHA256)
      ok = crypto.verify("sha256", Buffer.from(payload_json, "utf8"), pubPem, sigBuf);
    }
  } catch (e) {
    return [
      {
        code: "SIGNER_VERIFY_ERROR",
        severity: "BLOCK",
        message: "Signer signature verification threw an error.",
        details: { error: String((e as any)?.message ?? e) } as any,
      },
    ];
  }

  if (!ok) {
    return [
      {
        code: "SIGNER_SIGNATURE_INVALID",
        severity: "BLOCK",
        message: "Signer signature invalid for canonical signer-binding payload.",
        details: { signer_id, signature_alg } as any,
      },
    ];
  }

  return [];
}

