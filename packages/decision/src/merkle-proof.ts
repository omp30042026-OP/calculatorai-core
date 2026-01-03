// packages/decision/src/merkle-proof.ts
import crypto from "node:crypto";
import type { MerkleProof, MerkleProofStep } from "./store.js";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Same Merkle combine rule as Feature 21:
 *   parent = sha256Hex(`${left}:${right}`)
 */
function combine(left: string, right: string): string {
  return sha256Hex(`${left}:${right}`);
}

/**
 * Build a Merkle inclusion proof for leaf index `idx` (0-based) from `leaves`.
 * - leaves must be in seq order (seq=1 is leaves[0])
 * - duplicates last leaf if odd (same as your root builder)
 */
export function buildMerkleProofFromLeaves(input: {
  decision_id: string;
  up_to_seq: number;
  seq: number; // 1-based
  leaves: string[];
}): MerkleProof | null {
  const { decision_id, up_to_seq, seq, leaves } = input;

  if (up_to_seq <= 0) return null;
  if (seq <= 0 || seq > up_to_seq) return null;
  if (leaves.length !== up_to_seq) return null;

  const idx0 = seq - 1;
  const leaf_hash = leaves[idx0];
  if (!leaf_hash) return null;

  let index = idx0;
  let level = leaves.slice();
  const siblings: MerkleProofStep[] = [];

  while (level.length > 1) {
    const isRight = index % 2 === 1;
    const pairIndex = isRight ? index - 1 : index + 1;

    const left = isRight ? level[pairIndex]! : level[index]!;
    const right = isRight
      ? level[index]!
      : (level[pairIndex] ?? level[index]!); // duplicate last if odd

    // record sibling relative to the running hash
    if (isRight) {
      // current is on the right, sibling is left
      siblings.push({ hash: left, position: "left" });
    } else {
      // current is on the left, sibling is right (or duplicated self)
      siblings.push({ hash: right, position: "right" });
    }

    // build next level
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1] ?? l;
      next.push(combine(l, r));
    }
    level = next;

    // move index up
    index = Math.floor(index / 2);
  }

  return {
    decision_id,
    up_to_seq,
    seq,
    leaf_hash,
    siblings,
  };
}

export type VerifyMerkleProofResult =
  | {
      ok: true;
      decision_id: string;
      seq: number;
      up_to_seq: number;
      expected_root: string;
      computed_root: string;
    }
  | {
      ok: false;
      decision_id: string;
      seq: number;
      up_to_seq: number;
      expected_root: string | null;
      computed_root: string | null;
      message: string;
    };

/**
 * Verify inclusion proof (pure function).
 */
export function verifyMerkleProof(
  proof: MerkleProof,
  expected_root: string | null
): VerifyMerkleProofResult {
  if (!expected_root) {
    return {
      ok: false,
      decision_id: proof.decision_id,
      seq: proof.seq,
      up_to_seq: proof.up_to_seq,
      expected_root: null,
      computed_root: null,
      message: "Missing expected root hash.",
    };
  }

  let cur = proof.leaf_hash;

  for (const step of proof.siblings) {
    cur = step.position === "left" ? combine(step.hash, cur) : combine(cur, step.hash);
  }

  if (cur !== expected_root) {
    return {
      ok: false,
      decision_id: proof.decision_id,
      seq: proof.seq,
      up_to_seq: proof.up_to_seq,
      expected_root,
      computed_root: cur,
      message: "Merkle proof verification failed (root mismatch).",
    };
  }

  return {
    ok: true,
    decision_id: proof.decision_id,
    seq: proof.seq,
    up_to_seq: proof.up_to_seq,
    expected_root,
    computed_root: cur,
  };
}

