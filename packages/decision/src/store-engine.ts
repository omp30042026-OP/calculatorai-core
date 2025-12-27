// packages/decision/src/store-engine.ts
import { createDecisionV2 } from "./decision.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { PolicyViolation } from "./policy.js";
import type { DecisionStore } from "./store.js";

export type StoreApplyResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

function nowIso(opts: DecisionEngineOptions): string {
  return (opts.now ?? (() => new Date().toISOString()))();
}

/**
 * Store-backed apply:
 * V3 additions:
 * - optional optimistic locking via expected_current_version
 * - optional idempotency via idempotency_key (store may dedupe)
 * - optional atomic txn via store.runInTransaction
 *
 * Snapshot additions (read-path only):
 * - if store.getLatestSnapshot exists, replay starts from that snapshot
 * - if store.listEventsAfter exists, only reads events after snapshot seq
 */
export async function applyEventWithStore(
  store: DecisionStore,
  input: {
    decision_id: string;
    event: DecisionEvent;
    metaIfCreate?: Record<string, unknown>;

    // V3: safe retries (client-supplied)
    idempotency_key?: string;

    // V3: optimistic locking
    expected_current_version?: number;
  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  const run = store.runInTransaction
    ? store.runInTransaction.bind(store)
    : async <T>(fn: () => Promise<T>) => fn();

  return run(async () => {
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

    // helper: choose replay base (snapshot if available, else root)
    const snap = store.getLatestSnapshot
      ? await store.getLatestSnapshot(input.decision_id)
      : null;

    const baseDecision = snap?.decision ?? root;
    const baseSeq = snap?.seq ?? 0;

    async function loadEventsAfterSeq(afterSeq: number) {
      if (store.listEventsAfter) return store.listEventsAfter(input.decision_id, afterSeq);
      const all = await store.listEvents(input.decision_id);
      return all.filter((r) => r.seq > afterSeq);
    }

    async function replayFromBase(): Promise<StoreApplyResult> {
      const recs = await loadEventsAfterSeq(baseSeq);
      const events = recs.map((r) => r.event);
      const rr = replayDecision(baseDecision, events, opts);

      if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };
      await store.putDecision(rr.decision);
      return { ok: true, decision: rr.decision, warnings: rr.warnings };
    }

    // 2) idempotency shortcut if store supports lookup
    if (input.idempotency_key && store.findEventByIdempotencyKey) {
      const existing = await store.findEventByIdempotencyKey(
        input.decision_id,
        input.idempotency_key
      );
      if (existing) {
        // Event already appended previously → just materialize from base (snapshot/root)
        return replayFromBase();
      }
    }

    // 3) append event
    await store.appendEvent(input.decision_id, {
      at: nowIso(opts),
      event: input.event,
      idempotency_key: input.idempotency_key,
    });

    // 4) replay -> materialize current (from snapshot/root)
    return replayFromBase();
  });
}

