import { merkleRootHex } from "./merkle.js";

export type MerkleConsistencyProof = {
  old_size: number;
  new_size: number;
  proof: string[];
};

/**
 * Build consistency proof that tree(old_size) ⊆ tree(new_size)
 */
export function buildConsistencyProof(
  leaves: string[],
  old_size: number
): MerkleConsistencyProof {
  if (old_size <= 0 || old_size > leaves.length) {
    throw new Error("Invalid old_size");
  }

  const proof: string[] = [];
  let idx = old_size;
  let size = leaves.length;
  let level = leaves.slice();

  while (size > 1) {
    if (idx % 2 === 1) {
      proof.push(level[idx - 1]!);
    }
    idx = Math.floor(idx / 2);

    const next: string[] = [];
    for (let i = 0; i < size; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(merkleRootHex([left, right])!);
    }

    level = next;
    size = level.length;
  }

  return {
    old_size,
    new_size: leaves.length,
    proof,
  };
}

