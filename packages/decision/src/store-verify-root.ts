// packages/decision/src/store-verify-root.ts
import crypto from "node:crypto";
import type { DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Must match sqlite-store.ts merkleRootHex() logic
function merkleRootHex(leaves: string[]): string | null {
  if (leaves.length === 0) return null;

  let level = leaves.slice();
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

export type VerifyRootFromSnapshotResult =
  | {
      ok: true;
      decision_id: string;
      snapshot_up_to_seq: number;
      snapshot_root_hash: string | null;
      computed_root_hash: string | null;
      message?: string;
    }
  | {
      ok: false;
      decision_id: string;
      snapshot_up_to_seq?: number | null;
      snapshot_root_hash?: string | null;
      computed_root_hash?: string | null;
      code:
        | "NO_SNAPSHOT"
        | "NO_ROOT_HASH_IN_SNAPSHOT"
        | "STORE_MISSING_GET_EVENT_BY_SEQ"
        | "MISSING_EVENT_HASH"
        | "ROOT_HASH_MISMATCH";
      message: string;
      missing_seq?: number | null;
    };

/**
 * ✅ Feature 22: Verify Merkle root from the latest snapshot.
 *
 * Requirements:
 * - snapshotStore must provide getLatestSnapshot (you can pass the same sqlite store)
 * - store should implement getEventBySeq for efficient random access
 *
 * Verification:
 * - recompute Merkle root over event hashes for seq 1..snapshot.up_to_seq
 * - compare with snapshot.root_hash
 */
export async function verifyDecisionRootFromSnapshot(
  store: DecisionStore,
  decision_id: string,
  snapshotStore?: DecisionSnapshotStore
): Promise<VerifyRootFromSnapshotResult> {
  const ss: DecisionSnapshotStore | undefined = snapshotStore ?? (store as any);

  if (!ss?.getLatestSnapshot) {
    return {
      ok: false,
      decision_id,
      code: "NO_SNAPSHOT",
      message: "No snapshotStore available (getLatestSnapshot missing).",
    };
  }

  const snapshot = await ss.getLatestSnapshot(decision_id);
  if (!snapshot) {
    return {
      ok: false,
      decision_id,
      code: "NO_SNAPSHOT",
      message: "No snapshot found",
    };
  }

  const up_to_seq = snapshot.up_to_seq ?? 0;
  const snapshot_root_hash = (snapshot as any).root_hash ?? null;

  if (up_to_seq <= 0) {
    // root is expected to be null at seq<=0
    const computed_root_hash = null;
    const ok = (snapshot_root_hash ?? null) === null;
    return ok
      ? {
          ok: true,
          decision_id,
          snapshot_up_to_seq: up_to_seq,
          snapshot_root_hash: snapshot_root_hash ?? null,
          computed_root_hash,
          message: "up_to_seq <= 0; root is null.",
        }
      : {
          ok: false,
          decision_id,
          snapshot_up_to_seq: up_to_seq,
          snapshot_root_hash: snapshot_root_hash ?? null,
          computed_root_hash,
          code: "ROOT_HASH_MISMATCH",
          message: "Snapshot root_hash is not null but up_to_seq <= 0 implies null.",
        };
  }

  if (typeof snapshot_root_hash !== "string" || snapshot_root_hash.length === 0) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: up_to_seq,
      snapshot_root_hash: snapshot_root_hash ?? null,
      code: "NO_ROOT_HASH_IN_SNAPSHOT",
      message: "Snapshot has no root_hash; cannot verify.",
    };
  }

  if (!store.getEventBySeq) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: up_to_seq,
      snapshot_root_hash,
      code: "STORE_MISSING_GET_EVENT_BY_SEQ",
      message: "Store does not implement getEventBySeq (required for root verification).",
    };
  }

  const hashes: string[] = [];
  for (let seq = 1; seq <= up_to_seq; seq++) {
    const rec = await store.getEventBySeq(decision_id, seq);
    const h = (rec as any)?.hash ?? null;

    if (typeof h !== "string" || h.length === 0) {
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: up_to_seq,
        snapshot_root_hash,
        code: "MISSING_EVENT_HASH",
        message: `Missing event hash at seq=${seq}; cannot compute Merkle root.`,
        missing_seq: seq,
      };
    }

    hashes.push(h);
  }

  const computed_root_hash = merkleRootHex(hashes);

  if (computed_root_hash !== snapshot_root_hash) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: up_to_seq,
      snapshot_root_hash,
      computed_root_hash,
      code: "ROOT_HASH_MISMATCH",
      message: "Snapshot root_hash does not match computed Merkle root.",
    };
  }

  return {
    ok: true,
    decision_id,
    snapshot_up_to_seq: up_to_seq,
    snapshot_root_hash,
    computed_root_hash,
  };
}

