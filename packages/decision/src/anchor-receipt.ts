// packages/decision/src/anchor-receipt.ts
import type { DecisionAnchorRecord } from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

export type DecisionAnchorReceipt = {
  seq: number;
  at: string;
  decision_id: string;
  snapshot_up_to_seq: number;
  checkpoint_hash?: string | null;
  root_hash?: string | null;
  prev_hash?: string | null;
  hash: string;
};

export function makeAnchorReceipt(anchor: DecisionAnchorRecord): DecisionAnchorReceipt {
  if (!anchor.hash) {
    throw new Error("Cannot make receipt: anchor.hash is missing.");
  }

  return {
    seq: anchor.seq,
    at: anchor.at,
    decision_id: anchor.decision_id,
    snapshot_up_to_seq: anchor.snapshot_up_to_seq,
    checkpoint_hash: anchor.checkpoint_hash ?? null,
    root_hash: anchor.root_hash ?? null,
    prev_hash: anchor.prev_hash ?? null,
    hash: anchor.hash,
  };
}

export function verifyAnchorReceipt(receipt: DecisionAnchorReceipt): {
  ok: boolean;
  expected_hash: string;
  actual_hash: string;
} {
  const expected_hash = computeAnchorHash({
    seq: receipt.seq,
    at: receipt.at,
    decision_id: receipt.decision_id,
    snapshot_up_to_seq: receipt.snapshot_up_to_seq,
    checkpoint_hash: receipt.checkpoint_hash ?? null,
    root_hash: receipt.root_hash ?? null,
    prev_hash: receipt.prev_hash ?? null,
  });

  const actual_hash = receipt.hash;

  return {
    ok: expected_hash === actual_hash,
    expected_hash,
    actual_hash,
  };
}

