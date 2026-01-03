// packages/decision/src/store-verify.ts
import crypto from "node:crypto";
import type { DecisionEvent } from "./events.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

export type VerifyHashChainOptions = {
  /**
   * If true, verification will return ok=true even if hashes are missing,
   * but will report that chain is unverifiable.
   * Default: false (missing hashes => ok=false)
   */
  allowMissingHashes?: boolean;
};

export type VerifyHashChainResult =
  | {
      ok: true;
      decision_id: string;
      verified_count: number;
      last_seq: number | null;
      last_hash: string | null;
      message?: string;
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
    };

// ✅ Feature 19 result
export type VerifyFromSnapshotResult =
  | {
      ok: true;
      decision_id: string;
      snapshot_up_to_seq: number;
      verified_count: number; // number of delta events verified
      from_seq: number; // first verified seq (up_to_seq+1) OR up_to_seq if no delta
      to_seq: number; // last verified seq (or up_to_seq if no delta)
      last_hash: string | null; // last event hash in chain after verification
      message?: string;
    }
  | {
      ok: false;
      decision_id: string;
      snapshot_up_to_seq: number | null;
      verified_count: number;
      code:
        | "NO_SNAPSHOT"
        | "SNAPSHOT_MISSING_CHECKPOINT_HASH"
        | "CHECKPOINT_EVENT_NOT_FOUND"
        | "CHECKPOINT_HASH_MISMATCH"
        | "MISSING_HASHES"
        | "PREV_HASH_MISMATCH"
        | "HASH_MISMATCH"
        | "NON_MONOTONIC_SEQ";
      message: string;
      expected?: string | null;
      actual?: string | null;
      failed_seq?: number | null;
    };

// -------------------------
// Stable hashing (must match sqlite-store.ts)
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
      if (typeof vv === "undefined") continue; // keep JSON-like behavior
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
  event: DecisionEvent;
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
// Verify full chain
// -------------------------
export async function verifyDecisionHashChain(
  store: DecisionStore,
  decision_id: string,
  opts: VerifyHashChainOptions = {}
): Promise<VerifyHashChainResult> {
  const allowMissingHashes = opts.allowMissingHashes ?? false;
  const events: DecisionEventRecord[] = await store.listEvents(decision_id);

  if (events.length === 0) {
    return {
      ok: true,
      decision_id,
      verified_count: 0,
      last_seq: null,
      last_hash: null,
      message: "No events to verify.",
    };
  }

  let verified = 0;
  let prevHash: string | null = null;
  let prevSeq = 0;

  for (const r of events) {
    if (r.seq <= prevSeq) {
      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "NON_MONOTONIC_SEQ",
        message: `Non-monotonic seq encountered: got ${r.seq} after ${prevSeq}.`,
      };
    }
    prevSeq = r.seq;

    const storedPrev = (r as any).prev_hash ?? null;
    const storedHash = (r as any).hash ?? null;

    if (!storedHash) {
      if (allowMissingHashes) {
        return {
          ok: true,
          decision_id,
          verified_count: verified,
          last_seq: events[events.length - 1]?.seq ?? null,
          last_hash: null,
          message: "Hashes are missing; chain is not verifiable (allowMissingHashes=true).",
        };
      }

      return {
        ok: false,
        decision_id,
        verified_count: verified,
        failed_seq: r.seq,
        code: "MISSING_HASHES",
        message: `Missing hash fields at seq=${r.seq}.`,
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
      };
    }

    verified += 1;
    prevHash = storedHash;
  }

  return {
    ok: true,
    decision_id,
    verified_count: verified,
    last_seq: events[events.length - 1]?.seq ?? null,
    last_hash: prevHash,
  };
}

// -------------------------
// ✅ Feature 19: Verify from snapshot checkpoint, then only verify delta
// -------------------------
async function loadEventsFrom(store: DecisionStore, decision_id: string, after_seq: number) {
  if (store.listEventsFrom) return store.listEventsFrom(decision_id, after_seq);
  const all = await store.listEvents(decision_id);
  return all.filter((r) => r.seq > after_seq).sort((a, b) => a.seq - b.seq);
}

export async function verifyDecisionFromSnapshot(
  store: DecisionStore,
  decision_id: string,
  snapStore: DecisionSnapshotStore,
  opts: VerifyHashChainOptions = {}
): Promise<VerifyFromSnapshotResult> {
  const allowMissingHashes = opts.allowMissingHashes ?? false;

  const snap = await snapStore.getLatestSnapshot(decision_id);
  if (!snap) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: null,
      verified_count: 0,
      code: "NO_SNAPSHOT",
      message: "No snapshot available for decision.",
    };
  }

  const upTo = snap.up_to_seq ?? 0;
  const checkpointHash = (snap as any).checkpoint_hash ?? null;

  if (!checkpointHash) {
    if (allowMissingHashes) {
      // Fall back to full verification (but return as Feature 19 result)
      const full = await verifyDecisionHashChain(store, decision_id, opts);
      if (full.ok) {
        return {
          ok: true,
          decision_id,
          snapshot_up_to_seq: upTo,
          verified_count: full.verified_count,
          from_seq: 1,
          to_seq: full.last_seq ?? 0,
          last_hash: full.last_hash ?? null,
          message:
            "Snapshot missing checkpoint_hash; performed full-chain verification (allowMissingHashes=true).",
        };
      }
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: full.verified_count,
        code: full.code,
        message: full.message,
        expected: (full as any).expected ?? null,
        actual: (full as any).actual ?? null,
        failed_seq: (full as any).failed_seq ?? null,
      };
    }

    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: upTo,
      verified_count: 0,
      code: "SNAPSHOT_MISSING_CHECKPOINT_HASH",
      message: "Snapshot is missing checkpoint_hash; cannot verify delta safely.",
    };
  }

  // 1) Verify checkpoint: event hash at up_to_seq must match snapshot.checkpoint_hash
  let checkpointEvent: DecisionEventRecord | null = null;

  if (upTo > 0 && store.getEventBySeq) {
    checkpointEvent = await store.getEventBySeq(decision_id, upTo);
  } else if (upTo > 0) {
    // fallback: scan minimal
    const all = await store.listEvents(decision_id);
    checkpointEvent = all.find((e) => e.seq === upTo) ?? null;
  }

  if (upTo > 0 && !checkpointEvent) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: upTo,
      verified_count: 0,
      code: "CHECKPOINT_EVENT_NOT_FOUND",
      message: `Checkpoint event not found at seq=${upTo}.`,
    };
  }

  const eventHashAtCheckpoint = upTo === 0 ? null : ((checkpointEvent as any)?.hash ?? null);

  if (upTo > 0 && !eventHashAtCheckpoint) {
    if (!allowMissingHashes) {
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: 0,
        code: "MISSING_HASHES",
        message: `Missing event.hash at checkpoint seq=${upTo}.`,
        failed_seq: upTo,
      };
    }
    // if allowed, we can’t trust delta either; do full verification
    const full = await verifyDecisionHashChain(store, decision_id, opts);
    if (full.ok) {
      return {
        ok: true,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: full.verified_count,
        from_seq: 1,
        to_seq: full.last_seq ?? 0,
        last_hash: full.last_hash ?? null,
        message:
          "Checkpoint event hash missing; performed full-chain verification (allowMissingHashes=true).",
      };
    }
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: upTo,
      verified_count: full.verified_count,
      code: full.code,
      message: full.message,
      expected: (full as any).expected ?? null,
      actual: (full as any).actual ?? null,
      failed_seq: (full as any).failed_seq ?? null,
    };
  }

  if (upTo > 0 && eventHashAtCheckpoint !== checkpointHash) {
    return {
      ok: false,
      decision_id,
      snapshot_up_to_seq: upTo,
      verified_count: 0,
      code: "CHECKPOINT_HASH_MISMATCH",
      message: `Snapshot checkpoint_hash does not match event.hash at seq=${upTo}.`,
      expected: eventHashAtCheckpoint,
      actual: checkpointHash,
      failed_seq: upTo,
    };
  }

  // 2) Verify delta events: seq > up_to_seq
  const delta = await loadEventsFrom(store, decision_id, upTo);

  if (delta.length === 0) {
    return {
      ok: true,
      decision_id,
      snapshot_up_to_seq: upTo,
      verified_count: 0,
      from_seq: upTo,
      to_seq: upTo,
      last_hash: checkpointHash,
      message: "No delta events after snapshot; checkpoint verified.",
    };
  }

  let verified = 0;
  let prevHash = checkpointHash; // chain anchor
  let prevSeq = upTo;

  for (const r of delta) {
    if (r.seq <= prevSeq) {
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: verified,
        code: "NON_MONOTONIC_SEQ",
        message: `Non-monotonic seq in delta: got ${r.seq} after ${prevSeq}.`,
        failed_seq: r.seq,
      };
    }
    prevSeq = r.seq;

    const storedPrev = (r as any).prev_hash ?? null;
    const storedHash = (r as any).hash ?? null;

    if (!storedHash) {
      if (allowMissingHashes) {
        return {
          ok: true,
          decision_id,
          snapshot_up_to_seq: upTo,
          verified_count: verified,
          from_seq: upTo + 1,
          to_seq: delta[delta.length - 1]!.seq,
          last_hash: null,
          message: "Hashes missing in delta; chain not verifiable (allowMissingHashes=true).",
        };
      }
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: verified,
        code: "MISSING_HASHES",
        message: `Missing hash fields at seq=${r.seq}.`,
        failed_seq: r.seq,
      };
    }

    const expectedPrev = prevHash;
    if ((storedPrev ?? null) !== expectedPrev) {
      return {
        ok: false,
        decision_id,
        snapshot_up_to_seq: upTo,
        verified_count: verified,
        code: "PREV_HASH_MISMATCH",
        message: `prev_hash mismatch at seq=${r.seq}.`,
        expected: expectedPrev,
        actual: storedPrev ?? null,
        failed_seq: r.seq,
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
        snapshot_up_to_seq: upTo,
        verified_count: verified,
        code: "HASH_MISMATCH",
        message: `hash mismatch at seq=${r.seq}.`,
        expected: computed,
        actual: storedHash,
        failed_seq: r.seq,
      };
    }

    verified += 1;
    prevHash = storedHash;
  }

  return {
    ok: true,
    decision_id,
    snapshot_up_to_seq: upTo,
    verified_count: verified,
    from_seq: upTo + 1,
    to_seq: delta[delta.length - 1]!.seq,
    last_hash: prevHash,
  };
}

