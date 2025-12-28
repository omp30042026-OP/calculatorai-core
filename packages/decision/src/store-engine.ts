// packages/decision/src/store-engine.ts
import { createDecisionV2 } from "./decision.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { PolicyViolation } from "./policy.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type {
  DecisionSnapshotStore,
  SnapshotPolicy,
  SnapshotRetentionPolicy,
} from "./snapshots.js";
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

    // ✅ V6.2: automatic retention/compaction hook
    snapshotRetentionPolicy?: SnapshotRetentionPolicy;
  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  const run = store.runInTransaction
    ? store.runInTransaction.bind(store)
    : async <T>(fn: () => Promise<T>) => fn();

  return run(async () => {
    // 0) optimistic lock
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
      await store.putDecision(root);
    }

    // 2) latest snapshot
    const snapshot = input.snapshotStore
      ? await input.snapshotStore.getLatestSnapshot(input.decision_id)
      : null;

    const baseDecision = snapshot?.decision ?? root;
    const baseSeq = snapshot?.up_to_seq ?? 0;

    // 3) idempotency shortcut
    if (input.idempotency_key && store.findEventByIdempotencyKey) {
      const existing = await store.findEventByIdempotencyKey(
        input.decision_id,
        input.idempotency_key
      );

      if (existing) {
        const deltaRecs = await loadDeltaEvents(store, input.decision_id, baseSeq);
        const rr = replayDecision(baseDecision, deltaRecs.map((r) => r.event), opts);
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

    // 5) replay delta after snapshot
    const deltaRecs = await loadDeltaEvents(store, input.decision_id, baseSeq);
    const rr = replayDecision(baseDecision, deltaRecs.map((r) => r.event), opts);

    if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };

    await store.putDecision(rr.decision);

    // 6) snapshot + V6.2 retention maintenance
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

        // ✅ V6.2: auto-retention + prune events
        const ret = input.snapshotRetentionPolicy;
        if (ret) {
          if (input.snapshotStore.pruneSnapshots && ret.keep_last_n_snapshots > 0) {
            await input.snapshotStore.pruneSnapshots(
              input.decision_id,
              ret.keep_last_n_snapshots
            );
          }

          if (
            ret.prune_events_up_to_latest_snapshot &&
            input.snapshotStore.pruneEventsUpToSeq
          ) {
            const latest = await input.snapshotStore.getLatestSnapshot(input.decision_id);
            if (latest) {
              await input.snapshotStore.pruneEventsUpToSeq(input.decision_id, latest.up_to_seq);
            }
          }
        }
      }
    }

    return { ok: true, decision: rr.decision, warnings: rr.warnings };
  });
}

