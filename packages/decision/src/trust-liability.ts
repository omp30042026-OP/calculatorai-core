// packages/decision/src/trust-liability.ts
import crypto from "node:crypto";

export type TrustInput = {
  decision_id: string;
  event: any;
  actor_id: string;
  actor_type: string;
  now: string;
  prev_state_hash?: string | null;
  next_state_hash?: string | null;
};

export type TrustResult = {
  trust_score: number; // 0..1
  trust_reason: string;
};

export type LiabilityReceipt = {
  decision_id: string;
  event_seq: number;

  receipt_id: string;                 // stable id
  kind: string;                       // version tag
  receipt_hash: string;               // tamper-evident hash of receipt content

  event_type: string;
  actor_id: string;
  actor_type: string;

  trust_score: number;
  trust_reason: string;

  state_before_hash?: string | null;
  state_after_hash?: string | null;

  // ✅ Personal Liability Shield (PLS) fields
  role?: string | null;
  scope?: string | null;
  risk_acceptance?: string | null;
  obligations_hash?: string | null;

  created_at: string;
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

export function computeTrust(input: TrustInput): TrustResult {
  // Minimal v1:
  const privileged = new Set(["APPROVE", "REJECT", "PUBLISH", "COMMIT_COUNTERFACTUAL"]);
  let score = 0.8;

  if (input.actor_type === "system") score = 0.98;
  if (privileged.has(input.event?.type)) score -= 0.1;

  // If event carries external attestation ref, bump trust slightly
  if (input.event?.meta?.attestation_id) score += 0.05;

  score = Math.max(0, Math.min(1, score));
  return { trust_score: score, trust_reason: "trust_v1_heuristic" };
}

export function makeLiabilityReceipt(params: {
  decision_id: string;
  event_seq: number;
  event: any;
  actor_id: string;
  actor_type: string;
  trust_score: number;
  trust_reason: string;
  state_before_hash?: string | null;
  state_after_hash?: string | null;

  // ✅ optional PLS inputs
  role?: string | null;
  scope?: string | null;
  risk_acceptance?: string | null;
  obligations_hash?: string | null;

  created_at: string;
}): LiabilityReceipt {
  const kind = "VERITASCALE_LIABILITY_RECEIPT_V1";

  // receipt_id: stable id for (decision_id,event_seq)
  const receipt_id = crypto
    .createHash("sha256")
    .update(`${params.decision_id}:${params.event_seq}:${kind}`)
    .digest("hex");

  // receipt_hash: hash over the content that matters (tamper-evident)
  const receiptPayload = JSON.stringify({
    kind,
    receipt_id,
    decision_id: params.decision_id,
    event_seq: params.event_seq,
    event_type: params.event?.type ?? null,
    actor_id: params.actor_id,
    actor_type: params.actor_type,
    trust_score: params.trust_score,
    trust_reason: params.trust_reason,
    state_before_hash: params.state_before_hash ?? null,
    state_after_hash: params.state_after_hash ?? null,

    role: params.role ?? null,
    scope: params.scope ?? null,
    risk_acceptance: params.risk_acceptance ?? null,
    obligations_hash: params.obligations_hash ?? null,

    created_at: params.created_at,
  });

  const receipt_hash = crypto.createHash("sha256").update(receiptPayload).digest("hex");

  return {
    decision_id: params.decision_id,
    event_seq: params.event_seq,
    receipt_id,
    kind,
    receipt_hash,
    event_type: params.event?.type,
    actor_id: params.actor_id,
    actor_type: params.actor_type,
    trust_score: params.trust_score,
    trust_reason: params.trust_reason,
    state_before_hash: params.state_before_hash ?? null,
    state_after_hash: params.state_after_hash ?? null,
    role: params.role ?? null,
    scope: params.scope ?? null,
    risk_acceptance: params.risk_acceptance ?? null,
    obligations_hash: params.obligations_hash ?? null,
    created_at: params.created_at,
  };
}