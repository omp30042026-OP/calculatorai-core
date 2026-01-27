// packages/decision/src/snapshot-runtime.ts
import { computeDecisionStateHash, normalizeForStateHash } from "./state-hash.js";

export { computeDecisionStateHash, normalizeForStateHash };

function getProvenanceTailHashFromDecision(decision: any): string | null {
  const a = decision?.artifacts ?? {};
  const extra = a?.extra ?? {};
  const bag = a.provenance ?? extra.provenance ?? null;

  const tail =
    bag && typeof bag === "object"
      ? (typeof bag.last_node_hash === "string" ? bag.last_node_hash : null)
      : null;

  return tail ?? null;
}

export type SnapshotIntegrityCheck =
  | { ok: true }
  | { ok: false; code: "SNAPSHOT_STATE_HASH_MISMATCH" | "SNAPSHOT_PROVENANCE_TAIL_MISMATCH"; details?: any };

export function assertSnapshotIntegrity(input: any): SnapshotIntegrityCheck {
  const snapshot = input?.snapshot ?? input;
  if (!snapshot) return { ok: true };

  const snapDecision = (snapshot as any).decision ?? null;
  if (!snapDecision) return { ok: true };

  const storedStateHash =
    typeof (snapshot as any).state_hash === "string" ? (snapshot as any).state_hash : null;

  const expectedStateHash = computeDecisionStateHash(snapDecision);

  if (storedStateHash && storedStateHash !== expectedStateHash) {
    return {
      ok: false,
      code: "SNAPSHOT_STATE_HASH_MISMATCH",
      details: { stored: storedStateHash, expected: expectedStateHash },
    };
  }

  const storedTail =
    typeof (snapshot as any).provenance_tail_hash === "string"
      ? (snapshot as any).provenance_tail_hash
      : null;

  const expectedTail = getProvenanceTailHashFromDecision(snapDecision);

  if (storedTail && expectedTail && storedTail !== expectedTail) {
    return {
      ok: false,
      code: "SNAPSHOT_PROVENANCE_TAIL_MISMATCH",
      details: { stored: storedTail, expected: expectedTail },
    };
  }

  return { ok: true };
}

