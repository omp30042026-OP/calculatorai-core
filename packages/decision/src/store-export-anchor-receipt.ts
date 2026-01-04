// packages/decision/src/store-export-anchor-receipt.ts
import type { DecisionAnchorRecord, DecisionAnchorStore } from "./anchors.js";
import type { DecisionAnchorReceiptV2 } from "./anchor-receipt-v2.js";

/**
 * Find anchor by:
 * - (decision_id, snapshot_up_to_seq) if decision_id is provided
 * - otherwise by snapshot_up_to_seq only (first match)
 */
async function findAnchor(
  store: DecisionAnchorStore,
  decision_id: string | null,
  snapshot_up_to_seq: number
): Promise<DecisionAnchorRecord | null> {
  const upto = Math.floor(snapshot_up_to_seq);
  if (upto <= 0) return null;

  // If store has a direct helper (your sqlite-store does)
  const anyStore = store as any;
  if (decision_id && typeof anyStore.findAnchorByCheckpoint === "function") {
    const a = await anyStore.findAnchorByCheckpoint(decision_id, upto);
    if (a) return a as DecisionAnchorRecord;
  }

  // Universal fallback
  const all = await store.listAnchors();
  if (decision_id) {
    return all.find((a) => a.decision_id === decision_id && a.snapshot_up_to_seq === upto) ?? null;
  }
  return all.find((a) => a.snapshot_up_to_seq === upto) ?? null;
}

/**
 * ✅ Feature 30 (V2)
 * Returns DecisionAnchorReceiptV2 shape expected by anchor-receipt-v2.ts:
 *   { receipt: <anchorRecord>, head: <pinnedHead> }
 *
 * Supports BOTH calls:
 *   exportAnchorReceiptV2(store, 2)
 *   exportAnchorReceiptV2(store, "dec_id", 2)
 */
export async function exportAnchorReceiptV2(
  store: DecisionAnchorStore,
  snapshot_up_to_seq: number
): Promise<DecisionAnchorReceiptV2 | null>;
export async function exportAnchorReceiptV2(
  store: DecisionAnchorStore,
  decision_id: string,
  snapshot_up_to_seq: number
): Promise<DecisionAnchorReceiptV2 | null>;
export async function exportAnchorReceiptV2(
  store: DecisionAnchorStore,
  a: string | number,
  b?: number
): Promise<DecisionAnchorReceiptV2 | null> {
  const decision_id = typeof a === "string" ? a : null;
  const upto = typeof a === "number" ? a : (b ?? 0);

  const anchor = await findAnchor(store, decision_id, upto);
  if (!anchor?.hash) return null;

  const head = typeof store.getLastAnchor === "function" ? await store.getLastAnchor() : null;

  const pinned_head = head?.hash
    ? { seq: head.seq, hash: head.hash, at: head.at }
    : { seq: anchor.seq, hash: anchor.hash, at: anchor.at };

  // ✅ This must match DecisionAnchorReceiptV2 type:
  const receipt: DecisionAnchorReceiptV2 = {
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
    head: pinned_head,
  };

  return receipt;
}

/**
 * ✅ Legacy / Offline verify receipt (V1)
 * Supports:
 *   exportDecisionReceiptV1(store, 2)
 *   exportDecisionReceiptV1(store, "dec_id", 2)
 *   exportDecisionReceiptV1({ anchorStore: store, decision_id, snapshot_up_to_seq })
 */
export async function exportDecisionReceiptV1(input: {
  anchorStore: DecisionAnchorStore;
  decision_id?: string;
  snapshot_up_to_seq: number;

  // ✅ allow caller-provided fields (used by offline verify example)
  issued_at?: string;
  signature?: { alg: string; [k: string]: any };
}): Promise<any | null>;
export async function exportDecisionReceiptV1(
  store: DecisionAnchorStore,
  snapshot_up_to_seq: number
): Promise<any | null>;
export async function exportDecisionReceiptV1(
  store: DecisionAnchorStore,
  decision_id: string,
  snapshot_up_to_seq: number
): Promise<any | null>;
export async function exportDecisionReceiptV1(a: any, b?: any, c?: any): Promise<any | null> {
  // 1) object-style call: exportDecisionReceiptV1({ anchorStore, decision_id?, snapshot_up_to_seq, issued_at?, signature? })
  if (a && typeof a === "object" && a.anchorStore) {
    const store = a.anchorStore as DecisionAnchorStore;
    const decision_id =
      typeof a.decision_id === "string" && a.decision_id.length ? a.decision_id : null;
    const upto = Math.floor(Number(a.snapshot_up_to_seq ?? 0));

    const anchor = await findAnchor(store, decision_id, upto);
    if (!anchor?.hash) return null;

    const head = typeof store.getLastAnchor === "function" ? await store.getLastAnchor() : null;

    const pinned_head = head?.hash
      ? { seq: head.seq, hash: head.hash, at: head.at }
      : { seq: anchor.seq, hash: anchor.hash, at: anchor.at };

    const issued_at = typeof a.issued_at === "string" ? a.issued_at : new Date().toISOString();
    const signature = a.signature ?? { alg: "none" };

    return {
      receipt_version: "1.0",
      decision_id: anchor.decision_id,
      snapshot_up_to_seq: anchor.snapshot_up_to_seq,
      anchor: {
        seq: anchor.seq,
        at: anchor.at,
        decision_id: anchor.decision_id,
        snapshot_up_to_seq: anchor.snapshot_up_to_seq,
        checkpoint_hash: anchor.checkpoint_hash ?? null,
        root_hash: anchor.root_hash ?? null,
        prev_hash: anchor.prev_hash ?? null,
        hash: anchor.hash,
      },
      pinned_head,
      issued_at,
      signature,
    };
  }

  // 2) positional calls
  const store = a as DecisionAnchorStore;
  const decision_id = typeof b === "string" ? b : null;
  const upto = Math.floor(typeof b === "number" ? b : (c ?? 0));

  const anchor = await findAnchor(store, decision_id, upto);
  if (!anchor?.hash) return null;

  const head = typeof store.getLastAnchor === "function" ? await store.getLastAnchor() : null;

  const pinned_head = head?.hash
    ? { seq: head.seq, hash: head.hash, at: head.at }
    : { seq: anchor.seq, hash: anchor.hash, at: anchor.at };

  return {
    receipt_version: "1.0",
    decision_id: anchor.decision_id,
    snapshot_up_to_seq: anchor.snapshot_up_to_seq,
    anchor: {
      seq: anchor.seq,
      at: anchor.at,
      decision_id: anchor.decision_id,
      snapshot_up_to_seq: anchor.snapshot_up_to_seq,
      checkpoint_hash: anchor.checkpoint_hash ?? null,
      root_hash: anchor.root_hash ?? null,
      prev_hash: anchor.prev_hash ?? null,
      hash: anchor.hash,
    },
    pinned_head,
    issued_at: new Date().toISOString(),
    signature: { alg: "none" },
  };
}

