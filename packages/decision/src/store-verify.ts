import crypto from "node:crypto";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

export type VerifyHashChainOptions = {
  /**
   * If true, verification will return ok=true even if hashes are missing,
   * but will report that chain is unverifiable.
   * Default: false (missing hashes => ok=false)
   */
  allowMissingHashes?: boolean;

  /**
   * Verify only events with seq > start_after_seq.
   * Useful when you already trust a snapshot checkpoint up to some seq.
   */
  start_after_seq?: number;

  /**
   * If provided, the first verified event must have prev_hash === checkpoint_hash.
   * (Used for snapshot checkpoint verification.)
   */
  checkpoint_hash?: string | null;
};

export type VerifyHashChainResult =
  | {
      ok: true;
      decision_id: string;
      verified_count: number;
      last_seq: number | null;
      last_hash: string | null;
      message?: string;

      // extra helpful fields (non-breaking)
      from_seq?: number | null;
      to_seq?: number | null;
      started_after_seq?: number;
      used_checkpoint_hash?: string | null;
    }
  | {
      ok: false;
      decision_id: string;
      verified_count: number;
      failed_seq: number | null;
      code:
        | "MISSING_HASHES"
        | "PREV_HASH_MISMATCH"
        | "HASH_MISMATCH"
        | "NON_MONOTONIC_SEQ";
      message: string;
      expected?: string | null;
      actual?: string | null;

      // extra helpful fields (non-breaking)
      started_after_seq?: number;
      used_checkpoint_hash?: string | null;
    };

/**
 * Feature 20: Verify using latest snapshot as a checkpoint.
 * - If snapshot exists, we anchor verification at snapshot.up_to_seq and checkpoint hash.
 * - If snapshot does not contain a checkpoint hash, we compute it by hashing events up to up_to_seq.
 */
export type VerifyFromSnapshotResult =
  | ({
      ok: true;
      decision_id: string;
      verified_count: number;
      last_seq: number | null;
      last_hash: string | null;
      message?: string;
    } & {
      snapshot_used: boolean;
      snapshot_up_to_seq: number | null;
      snapshot_checkpoint_hash: string | null;
    })
  | ({
      ok: false;
      decision_id: string;
      verified_count: number;
      failed_seq: number | null;
      code:
        | "MISSING_HASHES"
        | "PREV_HASH_MISMATCH"
        | "HASH_MISMATCH"
        | "NON_MONOTONIC_SEQ";
      message: string;
      expected?: string | null;
      actual?: string | null;
    } & {
      snapshot_used: boolean;
      snapshot_up_to_seq: number | null;
      snapshot_checkpoint_hash: string | null;
    });

// -------------------------
// Stable hashing (MUST match sqlite-store.ts)
// -------------------------
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const norm = (v: any): any => {
    if (v === null) return null;
    if (typeof v !== "object") return v;

    if (seen.has(v)) return "[Circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map(norm);

    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "undefined") continue; // ✅ skip undefined (JSON-like)
      out[k] = norm(vv);
    }
    return out;
  };

  return JSON.stringify(norm(value));
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeEventHash(input: {
  decision_id: string;
  seq: number;
  at: string;
  idempotency_key?: string | null;
  event: unknown;
  prev_hash?: string | null;
}): string {
  const payload = stableStringify({
    decision_id: input.decision_id,
    seq: input.seq,
    at: input.at,
    idempotency_key: input.idempotency_key ?? null,
    event: input.event,
    prev_hash: input.prev_hash ?? null,
  });

  return sha256Hex(payload);
}

// -------------------------
// Verify chain
// -------------------------
export async function verifyDecisionHashChain(
  store: DecisionStore,
  decision_id: string,
  opts: VerifyHashChainOptions = {}
): Promise<VerifyHashChainResult> {
  const allowMissingHashes = opts.allowMissingHashes ?? false;
  const start_after_seq = Math.max(0, Math.floor(opts.start_after_seq ?? 0));
  const checkpoint_hash = opts.checkpoint_hash ?? null;

  const events: DecisionEventRecord[] =
    start_after_seq > 0 && typeof store.listEventsFrom === "function"
      ? await store.listEventsFrom(decision_id, start_after_seq)
      : (await store.listEvents(decision_id)).filter((e) => e.seq > start_after_seq);

  if (events.length === 0) {
    return {
      ok: true,
      decision_id,
      verified_count: 0,
      last_seq: start_after_seq > 0 ? start_after_seq : null,
      last_hash: checkpoint_hash,
      message: "No events to verify.",
      from_seq: null,
      to_seq: null,
      started_after_seq: start_after_seq,
      used_checkpoint_hash: checkpoint_hash,
    };
  }

  let verified = 0;
  let prevHash: string | null = checkpoint_hash;
  let prevSeq = start_after_seq;

  const firstSeq = events[0]?.seq ?? null;
  const lastSeq = events[events.length - 1]?.seq ?? null;

  for (const r of events) {
    if (r.seq <= prevSeq) {
      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "NON_MONOTONIC_SEQ",
        message: `Non-monotonic seq encountered: got ${r.seq} after ${prevSeq}.`,
        started_after_seq: start_after_seq,
        used_checkpoint_hash: checkpoint_hash,
      };
    }
    prevSeq = r.seq;

    const storedPrev = (r.prev_hash ?? null) as string | null;
    const storedHash = (r.hash ?? null) as string | null;

    if (!storedHash) {
      if (allowMissingHashes) {
        return {
          ok: true,
          decision_id,
          verified_count: verified,
          last_seq: lastSeq,
          last_hash: null,
          message: "Hashes are missing; chain is not verifiable (allowMissingHashes=true).",
          from_seq: firstSeq,
          to_seq: lastSeq,
          started_after_seq: start_after_seq,
          used_checkpoint_hash: checkpoint_hash,
        };
      }

      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "MISSING_HASHES",
        message: `Missing hash fields at seq=${r.seq}.`,
        started_after_seq: start_after_seq,
        used_checkpoint_hash: checkpoint_hash,
      };
    }

    const expectedPrev = prevHash;
    if ((storedPrev ?? null) !== expectedPrev) {
      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "PREV_HASH_MISMATCH",
        message: `prev_hash mismatch at seq=${r.seq}.`,
        expected: expectedPrev,
        actual: storedPrev ?? null,
        started_after_seq: start_after_seq,
        used_checkpoint_hash: checkpoint_hash,
      };
    }

    const computed = computeEventHash({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      idempotency_key: r.idempotency_key ?? null,
      event: r.event,
      prev_hash: expectedPrev,
    });

    if (computed !== storedHash) {
      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "HASH_MISMATCH",
        message: `hash mismatch at seq=${r.seq}.`,
        expected: computed,
        actual: storedHash,
        started_after_seq: start_after_seq,
        used_checkpoint_hash: checkpoint_hash,
      };
    }

    verified += 1;
    prevHash = storedHash;
  }

  return {
    ok: true,
    decision_id,
    verified_count: verified,
    last_seq: lastSeq,
    last_hash: prevHash,
    from_seq: firstSeq,
    to_seq: lastSeq,
    started_after_seq: start_after_seq,
    used_checkpoint_hash: checkpoint_hash,
  };
}

// -------------------------
// Feature 20: verify from snapshot checkpoint
// -------------------------
async function computeCheckpointHashUpToSeq(
  store: DecisionStore,
  decision_id: string,
  up_to_seq: number,
  allowMissingHashes: boolean
): Promise<string | null> {
  if (up_to_seq <= 0) return null;

  // We must compute deterministically from event content (not relying on stored hashes).
  const events = (await store.listEvents(decision_id)).filter((e) => e.seq <= up_to_seq);

  let prevHash: string | null = null;
  let prevSeq = 0;

  for (const r of events) {
    if (r.seq <= prevSeq) throw new Error(`Non-monotonic seq while checkpointing: ${r.seq} after ${prevSeq}`);
    prevSeq = r.seq;

    // if hashes exist, we can use them, but we still recompute to be strict/portable
    const computed = computeEventHash({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      idempotency_key: r.idempotency_key ?? null,
      event: r.event,
      prev_hash: prevHash,
    });

    const storedHash = (r.hash ?? null) as string | null;
    if (storedHash && storedHash !== computed) {
      // existing data is already inconsistent; surface as failure via chain verify later
      // but for checkpoint, return computed to avoid hiding tampering.
    } else if (!storedHash && !allowMissingHashes) {
      // If caller requires hashes but they’re missing, checkpoint can still be computed,
      // but overall verify should fail (handled in verifyDecisionHashChain).
    }

    prevHash = computed;
  }

  return prevHash;
}

export async function verifyDecisionFromSnapshot(
  store: DecisionStore & Partial<DecisionSnapshotStore>,
  decision_id: string,
  opts: VerifyHashChainOptions = {}
): Promise<VerifyFromSnapshotResult> {
  const allowMissingHashes = opts.allowMissingHashes ?? false;

  const snapStore = store as Partial<DecisionSnapshotStore>;
  const snap =
    typeof snapStore.getLatestSnapshot === "function"
      ? await snapStore.getLatestSnapshot(decision_id)
      : null;

  // If no snapshot support / no snapshot found, fall back to full chain verify.
  if (!snap) {
    const chain = await verifyDecisionHashChain(store, decision_id, {
      allowMissingHashes,
      start_after_seq: 0,
      checkpoint_hash: null,
    });

    if (chain.ok) {
      return {
        ok: true,
        decision_id,
        verified_count: chain.verified_count,
        last_seq: chain.last_seq,
        last_hash: chain.last_hash,
        message: chain.message,
        snapshot_used: false,
        snapshot_up_to_seq: null,
        snapshot_checkpoint_hash: null,
      };
    }

    return {
      ok: false,
      decision_id,
      verified_count: chain.verified_count,
      failed_seq: chain.failed_seq,
      code: chain.code,
      message: chain.message,
      expected: chain.expected ?? null,
      actual: chain.actual ?? null,
      snapshot_used: false,
      snapshot_up_to_seq: null,
      snapshot_checkpoint_hash: null,
    };
  }

  const snapAny = snap as any;
  const up_to_seq: number = Number(snapAny.up_to_seq ?? 0);

  // Prefer an explicit checkpoint hash if snapshot contains one (supports multiple field names).
  let checkpoint_hash: string | null =
    (typeof snapAny.checkpoint_hash === "string" && snapAny.checkpoint_hash) ||
    (typeof snapAny.checkpointHash === "string" && snapAny.checkpointHash) ||
    (typeof snapAny.last_hash === "string" && snapAny.last_hash) ||
    (typeof snapAny.hash === "string" && snapAny.hash) ||
    null;

  // If snapshot doesn’t store checkpoint hash, compute it up to up_to_seq.
  if (!checkpoint_hash && up_to_seq > 0) {
    checkpoint_hash = await computeCheckpointHashUpToSeq(store, decision_id, up_to_seq, allowMissingHashes);
  }

  const chain = await verifyDecisionHashChain(store, decision_id, {
    allowMissingHashes,
    start_after_seq: up_to_seq,
    checkpoint_hash,
  });

  if (chain.ok) {
    return {
      ok: true,
      decision_id,
      verified_count: chain.verified_count,
      last_seq: chain.last_seq,
      last_hash: chain.last_hash,
      message: chain.message,
      snapshot_used: true,
      snapshot_up_to_seq: up_to_seq,
      snapshot_checkpoint_hash: checkpoint_hash,
    };
  }

  return {
    ok: false,
    decision_id,
    verified_count: chain.verified_count,
    failed_seq: chain.failed_seq,
    code: chain.code,
    message: chain.message,
    expected: chain.expected ?? null,
    actual: chain.actual ?? null,
    snapshot_used: true,
    snapshot_up_to_seq: up_to_seq,
    snapshot_checkpoint_hash: checkpoint_hash,
  };
}

