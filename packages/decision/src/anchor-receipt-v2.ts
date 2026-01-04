// packages/decision/src/anchor-receipt-v2.ts
import type { DecisionAnchorRecord } from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

export type DecisionAnchorReceiptV2 = {
  receipt: {
    seq: number;
    at: string;
    decision_id: string;
    snapshot_up_to_seq: number;
    checkpoint_hash?: string | null;
    root_hash?: string | null;
    prev_hash?: string | null;
    hash: string;
  };

  // Optional: a verifier can pin to a known global head.
  head?: {
    seq: number;
    hash: string;
    at?: string;
  };
};

export function makeReceiptV2(anchor: DecisionAnchorRecord, head?: DecisionAnchorRecord): DecisionAnchorReceiptV2 {
  if (!anchor.hash) throw new Error("Cannot make receipt: anchor.hash missing");

  return {
    receipt: {
      seq: anchor.seq,
      at: anchor.at,
      decision_id: anchor.decision_id,
      snapshot_up_to_seq: anchor.snapshot_up_to_seq,
      checkpoint_hash: anchor.checkpoint_hash ?? null,
      root_hash: anchor.root_hash ?? null,
      prev_hash: anchor.prev_hash ?? null,
      hash: anchor.hash,
    },
    head: head?.hash
      ? { seq: head.seq, hash: head.hash, at: head.at }
      : undefined,
  };
}

export function verifyReceiptSelf(receipt: DecisionAnchorReceiptV2): {
  ok: boolean;
  expected_hash: string;
  actual_hash: string;
} {
  const r = receipt.receipt;

  const expected_hash = computeAnchorHash({
    seq: r.seq,
    at: r.at,
    decision_id: r.decision_id,
    snapshot_up_to_seq: r.snapshot_up_to_seq,
    checkpoint_hash: r.checkpoint_hash ?? null,
    root_hash: r.root_hash ?? null,
    prev_hash: r.prev_hash ?? null,
  });

  return { ok: expected_hash === r.hash, expected_hash, actual_hash: r.hash };
}

/**
 * Freshness / anti-rollback check using a pinned head.
 * This does NOT prove linkage unless you also verify the chain to head.
 * It prevents accepting a receipt that claims to be "after" the known head.
 */
export function verifyReceiptNotAfterHead(receipt: DecisionAnchorReceiptV2): {
  ok: boolean;
  message: string;
} {
  if (!receipt.head) return { ok: true, message: "No head pinned; skipping anti-rollback check." };

  if (receipt.receipt.seq > receipt.head.seq) {
    return {
      ok: false,
      message: `Receipt seq=${receipt.receipt.seq} is after pinned head seq=${receipt.head.seq} (rollback / future receipt).`,
    };
  }

  return { ok: true, message: "Receipt seq is <= pinned head seq." };
}

