// packages/decision/src/store-engine.ts
import { createDecisionV2 } from "./decision.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { PolicyViolation } from "./policy.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshotStore, SnapshotPolicy } from "./snapshots.js";
import { shouldCreateSnapshot } from "./snapshots.js";

export type StoreApplyResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

function nowIso(opts: DecisionEngineOptions): string {
  return (opts.now ?? (() => new Date().toISOString()))();
}

async function loadDeltaEvents(
  store: DecisionStore,
  decision_id: string,
  after_seq: number
): Promise<DecisionEventRecord[]> {
  if (store.listEventsFrom) return store.listEventsFrom(decision_id, after_seq);
  const all = await store.listEvents(decision_id);
  return all.filter((r) => r.seq > after_seq);
}

/**
 * Store-backed apply:
 * V3 additions:
 * - optional optimistic locking via expected_current_version
 * - optional idempotency via idempotency_key (store may dedupe)
 *
 * Snapshot additions:
 * - optional snapshotStore + snapshotPolicy for checkpointed replay
 *
 * NOTE:
 * - We DO NOT call store.runInTransaction here because better-sqlite3
 *   transactions are sync-only and cannot wrap async/await.
 */
export async function applyEventWithStore(
  store: DecisionStore,
  input: {
    decision_id: string;
    event: DecisionEvent;
    metaIfCreate?: Record<string, unknown>;

    idempotency_key?: string;
    expected_current_version?: number;

    snapshotStore?: DecisionSnapshotStore;
    snapshotPolicy?: SnapshotPolicy;
  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  // 0) optimistic lock (best-effort; store may implement helper)
  if (typeof input.expected_current_version === "number") {
    const curVer =
      (await store.getCurrentVersion?.(input.decision_id)) ??
      (await store.getDecision(input.decision_id))?.version ??
      null;

    if (curVer !== input.expected_current_version) {
      const d =
        (await store.getDecision(input.decision_id)) ??
        createDecisionV2(
          { decision_id: input.decision_id, meta: input.metaIfCreate ?? {} },
          opts.now
        );

      return {
        ok: false,
        decision: d,
        violations: [
          {
            code: "CONCURRENT_MODIFICATION",
            severity: "BLOCK",
            message: `Expected version ${input.expected_current_version} but current is ${curVer ?? "null"}.`,
          },
        ],
      };
    }
  }

  // 1) ensure root exists
  let root = await store.getRootDecision(input.decision_id);
  if (!root) {
    root = createDecisionV2(
      { decision_id: input.decision_id, meta: input.metaIfCreate ?? {} },
      opts.now
    );
    await store.createDecision(root);
    await store.putDecision(root); // set as current too
  }

  // 2) load latest snapshot (optional)
  const snapshot = input.snapshotStore
    ? await input.snapshotStore.getLatestSnapshot(input.decision_id)
    : null;

  const baseDecision = snapshot?.decision ?? root;
  const baseSeq = snapshot?.up_to_seq ?? 0;

  // 3) idempotency shortcut if store supports lookup
  if (input.idempotency_key && store.findEventByIdempotencyKey) {
    const existing = await store.findEventByIdempotencyKey(
      input.decision_id,
      input.idempotency_key
    );

    if (existing) {
      const deltaRecs = await loadDeltaEvents(store, input.decision_id, baseSeq);
      const events = deltaRecs.map((r) => r.event);
      const rr = replayDecision(baseDecision, events, opts);

      if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };

      await store.putDecision(rr.decision);
      return { ok: true, decision: rr.decision, warnings: rr.warnings };
    }
  }

  // 4) append event
  await store.appendEvent(input.decision_id, {
    at: nowIso(opts),
    event: input.event,
    idempotency_key: input.idempotency_key,
  });

  // 5) replay only delta after snapshot
  const deltaRecs = await loadDeltaEvents(store, input.decision_id, baseSeq);
  const events = deltaRecs.map((r) => r.event);
  const rr = replayDecision(baseDecision, events, opts);

  if (!rr.ok) {
    return { ok: false, decision: rr.decision, violations: rr.violations };
  }

  await store.putDecision(rr.decision);

  // 6) maybe create snapshot (optional)
  if (input.snapshotStore && input.snapshotPolicy) {
    const lastSeq = deltaRecs.length ? deltaRecs[deltaRecs.length - 1]!.seq : baseSeq;
    const lastSnapSeq = snapshot?.up_to_seq ?? 0;

    if (shouldCreateSnapshot(input.snapshotPolicy, lastSeq, lastSnapSeq)) {
      await input.snapshotStore.putSnapshot({
        decision_id: input.decision_id,
        up_to_seq: lastSeq,
        decision: rr.decision,
        created_at: nowIso(opts),
      });
    }
  }

  return { ok: true, decision: rr.decision, warnings: rr.warnings };
}

