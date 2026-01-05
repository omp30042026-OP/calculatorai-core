// packages/decision/src/receipt-verify.ts
import crypto from "node:crypto";
import type { DecisionReceiptV1, AnchorHeadPin } from "./decision-receipt.js";
import { computeAnchorHash } from "./anchors.js";
import type { Decision } from "./decision.js";

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

// ✅ Feature 34.x: compute decision state hash deterministically
function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}

// If later you want receipts signed, sign this exact payload.
export function computeReceiptSigningPayload(receipt: DecisionReceiptV1): string {
  // IMPORTANT: exclude signature field itself
  const { signature, ...rest } = receipt as any;
  return stableStringify(rest);
}

export type ReceiptVerifyResult =
  | { ok: true; message: string }
  | { ok: false; code: string; message: string; expected?: any; actual?: any };

export function verifyReceiptSelfIntegrity(receipt: DecisionReceiptV1): ReceiptVerifyResult {
  if (receipt.receipt_version !== "1.0") {
    return {
      ok: false,
      code: "UNSUPPORTED_VERSION",
      message: `Unsupported receipt_version: ${String(receipt.receipt_version)}`,
    };
  }

  // basic consistency
  if (receipt.decision_id !== receipt.anchor.decision_id) {
    return {
      ok: false,
      code: "DECISION_ID_MISMATCH",
      message: "receipt.decision_id must match anchor.decision_id",
      expected: receipt.decision_id,
      actual: receipt.anchor.decision_id,
    };
  }

  if (receipt.snapshot_up_to_seq !== receipt.anchor.snapshot_up_to_seq) {
    return {
      ok: false,
      code: "SNAPSHOT_SEQ_MISMATCH",
      message: "receipt.snapshot_up_to_seq must match anchor.snapshot_up_to_seq",
      expected: receipt.snapshot_up_to_seq,
      actual: receipt.anchor.snapshot_up_to_seq,
    };
  }

    const expected_anchor_hash = computeAnchorHash({
        seq: receipt.anchor.seq,
        at: receipt.anchor.at,
        decision_id: receipt.anchor.decision_id,
        snapshot_up_to_seq: receipt.anchor.snapshot_up_to_seq,
        checkpoint_hash: receipt.anchor.checkpoint_hash ?? null,
        root_hash: receipt.anchor.root_hash ?? null,
        state_hash: receipt.anchor.state_hash ?? null, // ✅ IMPORTANT
        prev_hash: receipt.anchor.prev_hash ?? null,
    });

  if (expected_anchor_hash !== receipt.anchor.hash) {
    return {
      ok: false,
      code: "ANCHOR_HASH_MISMATCH",
      message: "Anchor hash does not match computed hash.",
      expected: expected_anchor_hash,
      actual: receipt.anchor.hash,
    };
  }

  return { ok: true, message: "Receipt self-integrity checks passed." };
}

// ✅ Feature 34.x: optional check — if you have the decision object offline too
export function verifyReceiptStateHash(
  receipt: DecisionReceiptV1,
  decision?: Decision | unknown | null
): ReceiptVerifyResult {
  const expected = (receipt.anchor as any).state_hash ?? null;

  // if receipt doesn't carry it, skip (backward compatible)
  if (!expected) return { ok: true, message: "No state_hash in receipt; skipping state check." };

  // if caller didn't provide decision, skip
  if (!decision) return { ok: true, message: "No decision provided; skipping state check." };

  const actual = computeStateHash(decision);
  if (actual !== expected) {
    return {
      ok: false,
      code: "STATE_HASH_MISMATCH",
      message: "Receipt state_hash does not match provided decision state hash.",
      expected,
      actual,
    };
  }

  return { ok: true, message: "Decision state_hash check passed." };
}

// anti-rollback when you know the head you pinned at issuance time
export function verifyReceiptAgainstPinnedHead(
  receipt: DecisionReceiptV1,
  pinned_head?: AnchorHeadPin | null
): ReceiptVerifyResult {
  const pin = pinned_head ?? receipt.pinned_head ?? null;
  if (!pin) return { ok: true, message: "No pinned_head provided; skipping rollback check." };

  // If receipt claims an anchor seq beyond pinned head, it’s impossible.
  if (receipt.anchor.seq > pin.seq) {
    return {
      ok: false,
      code: "ROLLBACK_OR_FUTURE_RECEIPT",
      message: "Receipt anchor seq is greater than pinned head seq.",
      expected: `<= ${pin.seq}`,
      actual: receipt.anchor.seq,
    };
  }

  // If the receipt IS the head, hash must match
  if (receipt.anchor.seq === pin.seq && receipt.anchor.hash !== pin.hash) {
    return {
      ok: false,
      code: "PINNED_HEAD_HASH_MISMATCH",
      message: "Receipt anchor hash does not match pinned head hash.",
      expected: pin.hash,
      actual: receipt.anchor.hash,
    };
  }

  return { ok: true, message: "Pinned-head anti-rollback check passed." };
}

// optional signature verification hook (keep simple for now)
export function verifyReceiptSignature(
  receipt: DecisionReceiptV1,
  verifyFn?: (payload: string, sig: string, alg: string, key_id?: string) => boolean
): ReceiptVerifyResult {
  const sig = receipt.signature ?? null;
  if (!sig || sig.alg === "none") return { ok: true, message: "No signature; skipping signature verification." };
  if (!verifyFn) {
    return { ok: false, code: "SIGNATURE_VERIFY_FN_MISSING", message: "Receipt is signed but no verifyFn was provided." };
  }

  const payload = computeReceiptSigningPayload(receipt);
  const ok = verifyFn(payload, sig.sig ?? "", sig.alg, sig.key_id);
  return ok
    ? { ok: true, message: "Receipt signature verified." }
    : { ok: false, code: "SIGNATURE_INVALID", message: "Receipt signature invalid." };
}

// one-shot helper
export function verifyReceiptOffline(
  receipt: DecisionReceiptV1,
  opts?: {
    pinned_head?: AnchorHeadPin | null;
    decision?: Decision | unknown | null; // ✅ Feature 34.x
    verifySignatureFn?: (payload: string, sig: string, alg: string, key_id?: string) => boolean;
  }
): ReceiptVerifyResult {
  const r1 = verifyReceiptSelfIntegrity(receipt);
  if (!r1.ok) return r1;

  const r1b = verifyReceiptStateHash(receipt, opts?.decision ?? null);
  if (!r1b.ok) return r1b;

  const r2 = verifyReceiptAgainstPinnedHead(receipt, opts?.pinned_head ?? null);
  if (!r2.ok) return r2;

  const r3 = verifyReceiptSignature(receipt, opts?.verifySignatureFn);
  if (!r3.ok) return r3;

  return { ok: true, message: "Receipt offline verification passed." };
}

