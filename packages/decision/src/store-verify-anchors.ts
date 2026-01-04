import type { DecisionAnchorStore, DecisionAnchorRecord } from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

export type VerifyAnchorChainResult =
  | {
      ok: true;
      verified_count: number;
      last_seq: number | null;
      last_hash: string | null;
    }
  | {
      ok: false;
      verified_count: number;
      failed_seq: number | null;
      code: "MISSING_HASHES" | "PREV_HASH_MISMATCH" | "HASH_MISMATCH" | "NON_MONOTONIC_SEQ";
      message: string;
      expected?: string | null;
      actual?: string | null;
    };

export async function verifyGlobalAnchorChain(
  store: DecisionAnchorStore
): Promise<VerifyAnchorChainResult> {
  const anchors: DecisionAnchorRecord[] = await store.listAnchors();

  if (anchors.length === 0) {
    return { ok: true, verified_count: 0, last_seq: null, last_hash: null };
  }

  let verified = 0;
  let prevHash: string | null = null;
  let prevSeq = 0;

  for (const a of anchors) {
    if (a.seq <= prevSeq) {
      return {
        ok: false,
        verified_count: verified,
        failed_seq: a.seq,
        code: "NON_MONOTONIC_SEQ",
        message: `Non-monotonic seq: got ${a.seq} after ${prevSeq}.`,
      };
    }
    prevSeq = a.seq;

    const storedPrev = (a as any).prev_hash ?? null;
    const storedHash = (a as any).hash ?? null;

    if (!storedHash) {
      return {
        ok: false,
        verified_count: verified,
        failed_seq: a.seq,
        code: "MISSING_HASHES",
        message: `Missing hash fields at anchor seq=${a.seq}.`,
      };
    }

    if ((storedPrev ?? null) !== prevHash) {
      return {
        ok: false,
        verified_count: verified,
        failed_seq: a.seq,
        code: "PREV_HASH_MISMATCH",
        message: `prev_hash mismatch at anchor seq=${a.seq}.`,
        expected: prevHash,
        actual: storedPrev ?? null,
      };
    }

    const computed = computeAnchorHash({
      seq: a.seq,
      at: a.at,
      decision_id: a.decision_id,
      snapshot_up_to_seq: a.snapshot_up_to_seq,
      checkpoint_hash: a.checkpoint_hash ?? null,
      root_hash: a.root_hash ?? null,
      prev_hash: prevHash,
    });

    if (computed !== storedHash) {
      return {
        ok: false,
        verified_count: verified,
        failed_seq: a.seq,
        code: "HASH_MISMATCH",
        message: `hash mismatch at anchor seq=${a.seq}.`,
        expected: computed,
        actual: storedHash,
      };
    }

    verified += 1;
    prevHash = storedHash;
  }

  return {
    ok: true,
    verified_count: verified,
    last_seq: anchors[anchors.length - 1]?.seq ?? null,
    last_hash: prevHash,
  };
}







