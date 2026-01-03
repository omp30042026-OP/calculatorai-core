// packages/decision/src/store-verify-inclusion.ts
import type { DecisionSnapshotStore } from "./snapshots.js";
import type { DecisionStore } from "./store.js";
import { verifyMerkleProof } from "./merkle-proof.js";

export type VerifyInclusionResult =
  | {
      ok: true;
      decision_id: string;
      seq: number;
      up_to_seq: number;
      leaf_hash: string;
      expected_root: string;
      computed_root: string;
    }
  | {
      ok: false;
      decision_id: string;
      seq: number;
      message: string;
    };

/**
 * ✅ Feature 23:
 * Verify that event at `seq` is included in decision history up to the latest snapshot.
 *
 * Requires:
 * - snapshot.root_hash present
 * - store.getMerkleProof
 * - store.getEventBySeq (or the proof must carry correct leaf_hash, but we still cross-check if possible)
 */
export async function verifyEventIncludedFromLatestSnapshot(
  store: DecisionStore & Partial<DecisionSnapshotStore>,
  decision_id: string,
  seq: number
): Promise<VerifyInclusionResult> {
  if (!store.getLatestSnapshot) {
    return { ok: false, decision_id, seq, message: "Store does not support snapshots (getLatestSnapshot missing)." };
  }
  if (!store.getMerkleProof) {
    return { ok: false, decision_id, seq, message: "Store does not support Merkle proofs (getMerkleProof missing)." };
  }

  const snapshot = await store.getLatestSnapshot(decision_id);
  if (!snapshot) {
    return { ok: false, decision_id, seq, message: "No snapshot found." };
  }

  const up_to_seq = snapshot.up_to_seq;
  const expected_root = (snapshot as any).root_hash ?? null;

  if (!expected_root) {
    return { ok: false, decision_id, seq, message: "Snapshot is missing root_hash." };
  }

  const proof = await store.getMerkleProof(decision_id, seq, up_to_seq);
  if (!proof) {
    return { ok: false, decision_id, seq, message: "Could not build Merkle proof (missing hashes or invalid seq)." };
  }

  // Optional but strong: cross-check leaf hash equals stored event hash.
  if (store.getEventBySeq) {
    const ev = await store.getEventBySeq(decision_id, seq);
    const evHash = (ev as any)?.hash ?? null;
    if (!ev || !evHash) {
      return { ok: false, decision_id, seq, message: "Event not found or missing hash at that seq." };
    }
    if (evHash !== proof.leaf_hash) {
      return { ok: false, decision_id, seq, message: "Leaf hash mismatch vs stored event hash." };
    }
  }

  const vr = verifyMerkleProof(proof, expected_root);
  if (!vr.ok) {
    return { ok: false, decision_id, seq, message: vr.message };
  }

  return {
    ok: true,
    decision_id,
    seq,
    up_to_seq,
    leaf_hash: proof.leaf_hash,
    expected_root: vr.expected_root,
    computed_root: vr.computed_root,
  };
}

