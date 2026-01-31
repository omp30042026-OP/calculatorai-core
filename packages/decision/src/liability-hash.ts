// packages/decision/src/liability-hash.ts
import crypto from "node:crypto";
import { stableStringify } from "./stable-json.js";

// Re-export these from here so older imports don’t break.
export {
  computeDecisionStateHash,
  stripNonStateFieldsForHash,
  computeTamperStateHash,
  computePublicStateHash,
  stripForPublicHash,
  stripForTamperHash,
  normalizeForStateHash,
} from "./state-hash.js";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Receipt hash stays here (it’s NOT the same as decision state hash).
 * Receipts are a commitment to the event + computed hashes at time of write.
 */
export function computeReceiptHashV1(input: {
  decision_id: string;
  event_seq: number;
  event_type: string;
  actor_id: string;
  actor_type: string;
  trust_score: number;
  trust_reason: string | null;
  state_before_hash: string | null;
  state_after_hash: string | null;
  public_state_before_hash: string | null;
  public_state_after_hash: string | null;
  obligations_hash: string | null;
  created_at: string;
}): string {
  return sha256Hex(
    stableStringify({
      receipt_kind: "RECEIPT_V1",
      decision_id: input.decision_id,
      event_seq: input.event_seq,
      event_type: input.event_type,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      trust_score: input.trust_score,
      trust_reason: input.trust_reason,
      state_before_hash: input.state_before_hash,
      state_after_hash: input.state_after_hash,
      public_state_before_hash: input.public_state_before_hash,
      public_state_after_hash: input.public_state_after_hash,
      obligations_hash: input.obligations_hash,
      created_at: input.created_at,
    })
  );
}

