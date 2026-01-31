// packages/decision/src/dia.ts
import crypto from "node:crypto";
import stableJson from "./stable-json.js";
const { stableStringify } = stableJson as any;



export type DiaFinalizeType = "APPROVE" | "REJECT" | "PUBLISH";



export type DecisionIntegrityAttestationV1 = {
  kind: "DIA_V1";

  decision_id: string;
  event_seq: number;
  finalize_event_type: DiaFinalizeType;

  made_at: string;       // decision.created_at
  finalized_at: string;  // event.at

  actor: {
    actor_id: string | null;
    actor_type: string | null;
    roles?: string[] | null;
  };

  integrity: {
    public_state_hash: string | null;
    tamper_state_hash: string | null;
    liability_receipt_hash: string | null;
    obligations_hash: string | null;
  };

  lineage: {
    parent_decision_id: string | null;
    fork_receipt_hash: string | null;
  };

  // reserved for future: evidence pointers (hashes only), constraints, etc.
  notes?: Record<string, unknown> | null;
};

export type DiaSignature = {
  signature_kind: "DIA_SIGNATURE_V1";
  signed_by: string;       // e.g. org id, system id, external attestor id
  signature_hash: string;  // hash(signature payload)
  signed_at: string;       // ISO time
};

export type DiaSigner = {
  // return a deterministic signature object; caller controls key mgmt
  signDia: (params: {
    dia_hash: string;
    dia: DecisionIntegrityAttestationV1;
    now: string;
  }) => Promise<DiaSignature>;
};

export type DiaStore = {
  appendDia: (row: {
    decision_id: string;
    event_seq: number;
    dia_kind: "DIA_V1";
    dia_hash: string;
    dia_json: any;
    signature_json: any | null;
    created_at: string;
  }) => Promise<void>;
};

// -----------------------------
// stable stringify + sha256
// -----------------------------
function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// -----------------------------
// DIA hashing
// -----------------------------
export function computeDiaHashV1(dia: DecisionIntegrityAttestationV1): string {
  return sha256Hex(
    stableStringify({
      kind: "DIA_HASH_V1",
      dia,
    })
  );
}

// -----------------------------
// DIA builder
// -----------------------------
export function buildDiaV1(params: {
  decision_id: string;
  event_seq: number;
  finalize_event_type: DiaFinalizeType;
  made_at: string;
  finalized_at: string;

  actor_id: string | null;
  actor_type: string | null;
  roles?: string[] | null;

  public_state_hash: string | null;
  tamper_state_hash: string | null;
  liability_receipt_hash: string | null;
  obligations_hash: string | null;

  parent_decision_id: string | null;
  fork_receipt_hash: string | null;

  notes?: Record<string, unknown> | null;
}): DecisionIntegrityAttestationV1 {
  return {
    kind: "DIA_V1",
    decision_id: params.decision_id,
    event_seq: params.event_seq,
    finalize_event_type: params.finalize_event_type,
    made_at: params.made_at,
    finalized_at: params.finalized_at,
    actor: {
      actor_id: params.actor_id,
      actor_type: params.actor_type,
      roles: Array.isArray(params.roles)
        ? params.roles.map(String).sort()
        : null,
    },
    integrity: {
      public_state_hash: params.public_state_hash,
      tamper_state_hash: params.tamper_state_hash,
      liability_receipt_hash: params.liability_receipt_hash,
      obligations_hash: params.obligations_hash,
    },
    lineage: {
      parent_decision_id: params.parent_decision_id,
      fork_receipt_hash: params.fork_receipt_hash,
    },
    notes: params.notes ?? null,
  };
}

