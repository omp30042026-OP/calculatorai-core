// packages/decision/src/merkle.ts
import crypto from "node:crypto";

/**
 * Feature 21: Decision Merkle Root
 *
 * We build a binary Merkle tree over event hashes in ascending seq order.
 * - Leaf = event.hash (hex)
 * - Parent = sha256Hex(left + ":" + right)
 * - If odd number of nodes at a level, duplicate the last.
 *
 * Deterministic, easy to recompute, easy to compare across stores.
 */

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function merkleRootHex(leaves: string[]): string | null {
  if (!leaves.length) return null;

  // defensive: trim + normalize
  let level = leaves.map((h) => String(h).trim()).filter(Boolean);
  if (!level.length) return null;

  while (level.length > 1) {
    const next: string[] = [];

    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate last if odd
      next.push(sha256Hex(`${left}:${right}`));
    }

    level = next;
  }

  return level[0]!;
}

