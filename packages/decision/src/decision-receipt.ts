// packages/decision/src/decision-receipt.ts
export type AnchorHeadPin = {
  seq: number;
  hash: string;
  at?: string;
};

export type DecisionReceiptV1 = {
  receipt_version: "1.0";

  // what this receipt is about
  decision_id: string;
  snapshot_up_to_seq: number;

  // anchor it was issued from
  anchor: {
    seq: number;
    at: string;
    decision_id: string;
    snapshot_up_to_seq: number;

    checkpoint_hash: string | null;
    root_hash: string | null;

    prev_hash: string | null;
    hash: string;
  };

  // anti-rollback: optional pin to chain head at issue time
  pinned_head?: AnchorHeadPin | null;

  issued_at: string;

  // optional signature envelope (not required for Feature 31)
  signature?: {
    alg: "none" | "ed25519" | "hmac-sha256";
    key_id?: string;
    sig?: string; // base64 or hex (your choice, but be consistent)
  } | null;
};

export type DecisionReceipt = DecisionReceiptV1;

