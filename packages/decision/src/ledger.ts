// packages/decision/src/ledger.ts
import crypto from "node:crypto";
import type { LedgerSigAlg, LedgerSigner, LedgerVerifier } from "./ledger-signing.js";
import { isLedgerSigAlg } from "./ledger-signing.js";

export type LedgerEntryType =
  | "DECISION_EVENT_APPENDED"
  | "SNAPSHOT_CREATED"
  | "ANCHOR_APPENDED";

export type LedgerEntry = {
  seq: number;
  at: string;
  tenant_id: string | null;

  type: LedgerEntryType;

  decision_id: string | null;
  event_seq: number | null;
  snapshot_up_to_seq: number | null;
  anchor_seq: number | null;

  payload: any;

  prev_hash: string | null;
  hash: string;

  sig_alg: LedgerSigAlg | null;
  key_id: string | null;
  sig: string | null; // base64
};

export type LedgerResponsibility = {
  owner_id: string;          // e.g. "USER_123" or "ORG_FINANCE"
  owner_role?: string | null; // e.g. "CFO"
  org_id?: string | null;     // e.g. "ACME_INC"
  valid_from?: string | null; // ISO
  valid_to?: string | null;   // ISO
};

export type LedgerApprover = {
  approver_id: string;
  approver_role?: string | null;
};

export type LedgerEconomicImpact = {
  estimated_cost?: number | null; // in currency units
  currency?: string | null;       // "USD"
  risk_score?: number | null;     // 0..1
  regulatory_exposure?: "LOW" | "MEDIUM" | "HIGH" | null;
  notes?: string | null;
};

/**
 * Optional structure we put inside LedgerEntry.payload.
 * We keep payload as `any` for compatibility, but we standardize a shape.
 */
export type LedgerPayloadV12 = {
  event_type?: string | null;
  idempotency_key?: string | null;

  responsibility?: LedgerResponsibility | null;
  approver?: LedgerApprover | null;
  impact?: LedgerEconomicImpact | null;

  // allow anything else
  [k: string]: any;
};




export type LedgerQuery = {
  tenant_id?: string | null;
  limit?: number;
};

export type LedgerTrustLevel = "UNSIGNED" | "SIGNED_UNVERIFIED" | "SIGNED_VERIFIED" | "STRONG_VERIFIED";

export type LedgerVerifyError = {
  seq: number;
  expected_hash: string;
  stored_hash: string | null;
  stored_prev_hash: string | null;
  computed_prev_hash: string | null;

  signature_required: boolean;
  sig_alg: string | null;
  key_id: string | null;
  sig_present: boolean;
  sig_ok: boolean | null;

  // ✅ Feature 11-5
  trust_level: LedgerTrustLevel;
};

export type LedgerVerifyReport = {
  ledger_verified: boolean;
  ledger_errors: LedgerVerifyError[];

  // ✅ Feature 11-5: summary (non-breaking additive fields)
  trust_summary: {
    total: number;
    unsigned: number;
    signed_unverified: number;
    signed_verified: number;
    strong_verified: number;
    lowest_trust_level: LedgerTrustLevel;
  };
};

// ✅ Feature 11-4: registry abstraction (optional)
export type LedgerVerifierRegistry = {
  resolve(tenant_id: string, alg: LedgerSigAlg, key_id: string): LedgerVerifier | null;
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

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function computeLedgerEntryHash(input: {
  seq: number;
  at: string;
  tenant_id: string | null;
  type: LedgerEntryType;

  decision_id: string | null;
  event_seq: number | null;
  snapshot_up_to_seq: number | null;
  anchor_seq: number | null;

  payload: any;

  prev_hash: string | null;
}): string {
  const payload = stableStringify({
    seq: input.seq,
    at: input.at,
    tenant_id: input.tenant_id ?? null,
    type: input.type,

    decision_id: input.decision_id ?? null,
    event_seq: input.event_seq ?? null,
    snapshot_up_to_seq: input.snapshot_up_to_seq ?? null,
    anchor_seq: input.anchor_seq ?? null,

    payload: input.payload ?? null,

    prev_hash: input.prev_hash ?? null,
  });

  return sha256Hex(payload);
}

/**
 * Helper for stores:
 * - compute hash
 * - optionally sign it (signer signs the hash string)
 */
export function signLedgerHash(
  hash: string,
  signer?: LedgerSigner
): {
  sig_alg: LedgerSigAlg | null;
  key_id: string | null;
  sig: string | null;
} {
  if (!signer) return { sig_alg: null, key_id: null, sig: null };
  return {
    sig_alg: signer.alg,
    key_id: signer.key_id,
    sig: signer.sign(hash),
  };
}

// ✅ Feature 11-5: trust level helper
function trustLevelFor(entry: LedgerEntry, sig_ok: boolean | null): LedgerTrustLevel {
  const hasSig = Boolean(entry.sig && entry.sig_alg && entry.key_id);

  if (!hasSig) return "UNSIGNED";
  if (sig_ok !== true) return "SIGNED_UNVERIFIED";

  // stronger algs can be classified higher
  if (entry.sig_alg === "ED25519") return "STRONG_VERIFIED";
  return "SIGNED_VERIFIED";
}

function minTrust(a: LedgerTrustLevel, b: LedgerTrustLevel): LedgerTrustLevel {
  const rank: Record<LedgerTrustLevel, number> = {
    UNSIGNED: 0,
    SIGNED_UNVERIFIED: 1,
    SIGNED_VERIFIED: 2,
    STRONG_VERIFIED: 3,
  };
  return rank[a] <= rank[b] ? a : b;
}

export function verifyLedgerEntries(
  entries: LedgerEntry[],
  opts?: {
    require_signatures?: boolean;

    // existing
    resolveVerifier?: (e: LedgerEntry) => LedgerVerifier | null;

    // ✅ Feature 11-4
    verifierRegistry?: LedgerVerifierRegistry;
  }
): LedgerVerifyReport {
  const requireSigs = opts?.require_signatures === true;
  const resolveVerifier = opts?.resolveVerifier;
  const registry = opts?.verifierRegistry;

  const errors: LedgerVerifyError[] = [];
  let prevExpected: string | null = null;

  let unsigned = 0;
  let signed_unverified = 0;
  let signed_verified = 0;
  let strong_verified = 0;
  let lowest: LedgerTrustLevel = "STRONG_VERIFIED";

  for (const e of entries) {
    const expected = computeLedgerEntryHash({
      seq: e.seq,
      at: e.at,
      tenant_id: e.tenant_id ?? null,
      type: e.type,
      decision_id: e.decision_id ?? null,
      event_seq: e.event_seq ?? null,
      snapshot_up_to_seq: e.snapshot_up_to_seq ?? null,
      anchor_seq: e.anchor_seq ?? null,
      payload: e.payload ?? null,
      prev_hash: prevExpected,
    });

    const prevOk = e.prev_hash === prevExpected;
    const hashOk = e.hash === expected;

    let sig_ok: boolean | null = null;

    const sig_present = Boolean(e.sig && e.sig_alg && e.key_id);

    if (requireSigs) {
      if (!sig_present) {
        sig_ok = false;
      } else if (!isLedgerSigAlg(e.sig_alg)) {
        sig_ok = false;
      } else {
        // resolve verifier from registry or function
        let v: LedgerVerifier | null = null;

        if (registry && e.tenant_id && e.sig_alg && e.key_id) {
          v = registry.resolve(e.tenant_id, e.sig_alg, e.key_id);
        } else if (resolveVerifier) {
          v = resolveVerifier(e);
        }

        sig_ok = v ? v.verify(e.hash, e.sig!) : false;
      }

      const trust = trustLevelFor(e, sig_ok);
      lowest = minTrust(lowest, trust);

      if (!prevOk || !hashOk || sig_ok !== true) {
        errors.push({
          seq: e.seq,
          expected_hash: expected,
          stored_hash: e.hash ?? null,
          stored_prev_hash: e.prev_hash ?? null,
          computed_prev_hash: prevExpected,
          signature_required: true,
          sig_alg: e.sig_alg ?? null,
          key_id: e.key_id ?? null,
          sig_present,
          sig_ok,
          trust_level: trust,
        });
      }
    } else {
      // signatures optional
      if (sig_present && isLedgerSigAlg(e.sig_alg)) {
        let v: LedgerVerifier | null = null;

        if (registry && e.tenant_id && e.sig_alg && e.key_id) {
          v = registry.resolve(e.tenant_id, e.sig_alg, e.key_id);
        } else if (resolveVerifier) {
          v = resolveVerifier(e);
        }

        sig_ok = v ? v.verify(e.hash, e.sig!) : false;
      } else {
        sig_ok = null;
      }

      const trust = trustLevelFor(e, sig_ok === null ? null : sig_ok);
      lowest = minTrust(lowest, trust);

      if (!prevOk || !hashOk) {
        errors.push({
          seq: e.seq,
          expected_hash: expected,
          stored_hash: e.hash ?? null,
          stored_prev_hash: e.prev_hash ?? null,
          computed_prev_hash: prevExpected,
          signature_required: false,
          sig_alg: e.sig_alg ?? null,
          key_id: e.key_id ?? null,
          sig_present,
          sig_ok: sig_ok === null ? null : sig_ok,
          trust_level: trust,
        });
      }
    }

    // update counters
    const t = trustLevelFor(e, sig_ok);
    if (t === "UNSIGNED") unsigned++;
    else if (t === "SIGNED_UNVERIFIED") signed_unverified++;
    else if (t === "SIGNED_VERIFIED") signed_verified++;
    else strong_verified++;

    prevExpected = expected;
  }

  return {
    ledger_verified: errors.length === 0,
    ledger_errors: errors,
    trust_summary: {
      total: entries.length,
      unsigned,
      signed_unverified,
      signed_verified,
      strong_verified,
      lowest_trust_level: entries.length ? lowest : "UNSIGNED",
    },
  };
}


