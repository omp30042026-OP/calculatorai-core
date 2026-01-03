// packages/decision/src/store-verify-lineage.ts
import type { DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";
import { verifyDecisionHashChain, type VerifyHashChainOptions } from "./store-verify.js";

export type VerifyForkLineageOptions = {
  /**
   * If provided, verify parent hash at this exact parent seq.
   * If missing, we verify against parent LAST event hash.
   */
  parent_fork_seq?: number;

  /**
   * If you want snapshot-aware verification for speed, pass a snapshot store
   * and ensure your snapshots have checkpoint_hash (Feature 18).
   */
  snapshotStore?: DecisionSnapshotStore;

  /**
   * Forwarded to chain verification.
   */
  hash?: VerifyHashChainOptions;
};

export type VerifyForkLineageResult =
  | {
      ok: true;
      child_id: string;
      parent_id: string;
      child_verified_events: number;
      parent_verified_events: number;
      expected_parent_hash: string;
      actual_checkpoint_hash: string;
      parent_seq_used: number;
    }
  | {
      ok: false;
      child_id: string;
      parent_id?: string | null;
      code:
        | "CHILD_NOT_FOUND"
        | "MISSING_PARENT"
        | "PARENT_NOT_FOUND"
        | "PARENT_CHAIN_INVALID"
        | "CHILD_CHAIN_INVALID"
        | "MISSING_FORK_CHECKPOINT"
        | "PARENT_EVENT_NOT_FOUND"
        | "FORK_CHECKPOINT_MISMATCH";
      message: string;
      details?: any;
    };

/**
 * ✅ Feature 20
 * Verifies:
 * 1) parent hash-chain is valid
 * 2) child hash-chain is valid
 * 3) child.meta.fork_checkpoint_hash equals parent's hash at fork point (or parent's last hash)
 *
 * Convention:
 * - child.meta.fork_checkpoint_hash: string
 * - child.meta.fork_parent_seq: number (optional but recommended)
 */
export async function verifyForkLineage(
  store: DecisionStore,
  child_id: string,
  opts: VerifyForkLineageOptions = {}
): Promise<VerifyForkLineageResult> {
  const child = await store.getDecision(child_id);
  if (!child) {
    return { ok: false, child_id, code: "CHILD_NOT_FOUND", message: "Child decision not found." };
  }

  const parent_id = (child as any).parent_decision_id ?? null;
  if (!parent_id) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "MISSING_PARENT",
      message: "Child has no parent_decision_id; not a forked decision.",
    };
  }

  const parent = await store.getDecision(parent_id);
  if (!parent) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "PARENT_NOT_FOUND",
      message: "Parent decision not found.",
    };
  }

  // 1) verify parent chain
  const parentChain = await verifyDecisionHashChain(store, parent_id, opts.hash ?? {});
  if (!parentChain.ok) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "PARENT_CHAIN_INVALID",
      message: "Parent hash-chain verification failed.",
      details: parentChain,
    };
  }

  // 2) verify child chain
  const childChain = await verifyDecisionHashChain(store, child_id, opts.hash ?? {});
  if (!childChain.ok) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "CHILD_CHAIN_INVALID",
      message: "Child hash-chain verification failed.",
      details: childChain,
    };
  }

  // 3) read fork checkpoint from child meta
  const meta = ((child as any).meta ?? {}) as Record<string, any>;
  const checkpoint = meta.fork_checkpoint_hash ?? null;

  const metaForkSeqRaw = meta.fork_parent_seq;
  const metaForkSeq =
    typeof metaForkSeqRaw === "number" && Number.isFinite(metaForkSeqRaw) && metaForkSeqRaw > 0
      ? Math.floor(metaForkSeqRaw)
      : null;

  const parentSeqUsed =
    typeof opts.parent_fork_seq === "number" && opts.parent_fork_seq > 0
      ? Math.floor(opts.parent_fork_seq)
      : metaForkSeq ?? (parentChain.last_seq ?? 0);

  if (!checkpoint || typeof checkpoint !== "string") {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "MISSING_FORK_CHECKPOINT",
      message:
        "Missing child.meta.fork_checkpoint_hash. Store the parent hash at fork time on the child.",
      details: { expected_meta_keys: ["fork_checkpoint_hash", "fork_parent_seq?"] },
    };
  }

  // Resolve expected parent hash at parentSeqUsed
  let expectedParentHash: string | null = null;

  // Fast path: direct read if store supports it
  if (store.getEventBySeq) {
    const rec = await store.getEventBySeq(parent_id, parentSeqUsed);
    expectedParentHash = (rec as any)?.hash ?? null;
  } else {
    // fallback: scan listEvents
    const events = await store.listEvents(parent_id);
    const rec = events.find((e) => e.seq === parentSeqUsed) ?? null;
    expectedParentHash = (rec as any)?.hash ?? null;
  }

  // If parentSeqUsed == last_seq, we can fallback to last_hash if event not found
  if (!expectedParentHash && parentSeqUsed === (parentChain.last_seq ?? -1)) {
    expectedParentHash = parentChain.last_hash ?? null;
  }

  if (!expectedParentHash) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "PARENT_EVENT_NOT_FOUND",
      message: `Could not find parent event hash at seq=${parentSeqUsed}.`,
      details: { parentSeqUsed, parent_last_seq: parentChain.last_seq },
    };
  }

  if (expectedParentHash !== checkpoint) {
    return {
      ok: false,
      child_id,
      parent_id,
      code: "FORK_CHECKPOINT_MISMATCH",
      message: "Fork checkpoint mismatch: child does not match parent history at fork point.",
      details: {
        parentSeqUsed,
        expected_parent_hash: expectedParentHash,
        child_checkpoint_hash: checkpoint,
      },
    };
  }

  return {
    ok: true,
    child_id,
    parent_id,
    child_verified_events: childChain.verified_count,
    parent_verified_events: parentChain.verified_count,
    expected_parent_hash: expectedParentHash,
    actual_checkpoint_hash: checkpoint,
    parent_seq_used: parentSeqUsed,
  };
}
