// packages/decision/src/store-engine.ts
import { createDecisionV2 } from "./decision.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine.js";
import { replayDecision } from "./engine.js";
import type { PolicyViolation } from "./policy.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import type { DecisionSnapshotStore, SnapshotPolicy, SnapshotRetentionPolicy } from "./snapshots.js";
import { shouldCreateSnapshot, shouldPruneEventsAfterSnapshot } from "./snapshots.js";
import type { AnchorPolicy, DecisionAnchorStore } from "./anchors.js";
import crypto from "node:crypto";


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
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };

  return JSON.stringify(norm(value));
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}




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
    snapshotRetentionPolicy?: SnapshotRetentionPolicy;

    // anchors
    anchorStore?: DecisionAnchorStore;
    anchorPolicy?: AnchorPolicy;

    // (if you already have this, keep it)
    anchorRetentionPolicy?: { keep_last_n_anchors: number };
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

    // 2) load snapshot (optional)
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

    // 5) replay delta
    const deltaRecs = await loadDeltaEvents(store, input.decision_id, baseSeq);
    const rr = replayDecision(baseDecision, deltaRecs.map((r) => r.event), opts);

    if (!rr.ok) return { ok: false, decision: rr.decision, violations: rr.violations };

    await store.putDecision(rr.decision);

    // 6) snapshot + retention + anchors (optional)
    if (input.snapshotStore && input.snapshotPolicy) {
      const lastSeq = deltaRecs.length ? deltaRecs[deltaRecs.length - 1]!.seq : baseSeq;
      const lastSnapSeq = snapshot?.up_to_seq ?? 0;

      if (shouldCreateSnapshot(input.snapshotPolicy, lastSeq, lastSnapSeq)) {
        const lastRec = deltaRecs.length ? deltaRecs[deltaRecs.length - 1]! : null;
        const checkpoint_hash = lastRec && (lastRec as any).hash ? String((lastRec as any).hash) : null;



        function sha256Hex(s: string): string {
        return crypto.createHash("sha256").update(s, "utf8").digest("hex");
        }

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
            if (typeof vv === "undefined") continue;
            out[k] = norm(vv);
            }
            return out;
        };
        return JSON.stringify(norm(value));
        }

        function computeStateHash(decision: any): string {
        // hash the decision state at snapshot time
        return sha256Hex(stableStringify(decision));
        }

        // ✅ Feature 27: idempotent anchor for latest snapshot
        const anchorEnabled = input.anchorPolicy?.enabled ?? true;
        if (anchorEnabled && input.anchorStore) {
        const latest = await input.snapshotStore.getLatestSnapshot(input.decision_id);
        if (latest) {
            const aStore = input.anchorStore as any;

            const already =
            typeof aStore.getAnchorForSnapshot === "function"
                ? await aStore.getAnchorForSnapshot(input.decision_id, latest.up_to_seq)
                : typeof aStore.findAnchorByCheckpoint === "function"
                ? await aStore.findAnchorByCheckpoint(input.decision_id, latest.up_to_seq)
                : null;

            if (!already) {
            await input.anchorStore.appendAnchor({
                at: nowIso(opts),
                decision_id: input.decision_id,
                snapshot_up_to_seq: latest.up_to_seq,
                checkpoint_hash: (latest as any).checkpoint_hash ?? null,
                root_hash: (latest as any).root_hash ?? null,
                state_hash: computeStateHash(rr.decision),
                });
            }

            // optional anchor retention
            const keepN = input.anchorRetentionPolicy?.keep_last_n_anchors;
            if (typeof keepN === "number" && typeof aStore.pruneAnchors === "function") {
            await aStore.pruneAnchors(keepN);
            }
        }
        }

        // snapshot retention pass
        if (input.snapshotRetentionPolicy) {
          const keepLast = input.snapshotRetentionPolicy.keep_last_n_snapshots;

          if (input.snapshotStore.pruneSnapshots) {
            await input.snapshotStore.pruneSnapshots(input.decision_id, keepLast);
          }

          if (
            shouldPruneEventsAfterSnapshot(input.snapshotRetentionPolicy) &&
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

