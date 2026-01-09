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
import {
  shouldCreateSnapshot,
  shouldPruneEventsAfterSnapshot,
} from "./snapshots.js";
import type { AnchorPolicy, DecisionAnchorStore } from "./anchors.js";
import crypto from "node:crypto";

import { computeConsequencePreview } from "./consequence-preview.js";

// -----------------------------
// small utils
// -----------------------------
function nowIso(opts: DecisionEngineOptions): string {
  return (opts.now ?? (() => new Date().toISOString()))();
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

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
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

// -----------------------------
// result
// -----------------------------
export type StoreApplyResult =
  | {
      ok: true;
      decision: Decision;
      warnings: PolicyViolation[];
      consequence_preview?: ReturnType<typeof computeConsequencePreview>;
    }
  | {
      ok: false;
      decision: Decision;
      violations: PolicyViolation[];
      consequence_preview?: ReturnType<typeof computeConsequencePreview>;
    };

// -----------------------------
// main
// -----------------------------
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

    // optional anchor retention
    anchorRetentionPolicy?: { keep_last_n_anchors: number };

    // optional behavior
    block_on_consequence_block?: boolean; // default false
  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  const run = store.runInTransaction
    ? store.runInTransaction.bind(store)
    : async <T>(fn: () => Promise<T>) => fn();

  return run(async () => {
    // 1) ensure root exists (create if missing)
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

    const baseDecision = (snapshot as any)?.decision ?? root;
    const baseSeq = (snapshot as any)?.up_to_seq ?? 0;

    // 3) compute "current head" decision (before new event)
    const deltaBefore = await loadDeltaEvents(store, input.decision_id, baseSeq);
    const rrBefore = replayDecision(baseDecision, deltaBefore.map((r) => r.event), opts);

    // ✅ TS-safe narrowing (fixes the red lines)
    if (rrBefore.ok === false) {
      return {
        ok: false,
        decision: rrBefore.decision,
        violations: rrBefore.violations,
      };
    }

    const headDecision = rrBefore.decision;
    const headWarnings = rrBefore.warnings;

    // ✅ consequence preview should use the REAL current state
    const consequence_preview = computeConsequencePreview({
      decision: headDecision ?? null,
      event: input.event,
    });

    // 0) optimistic lock (after we know current head)
    if (typeof input.expected_current_version === "number") {
      const curVer =
        (await store.getCurrentVersion?.(input.decision_id)) ??
        (await store.getDecision(input.decision_id))?.version ??
        ((headDecision as any)?.version ?? null);

      if (curVer !== input.expected_current_version) {
        const d = (await store.getDecision(input.decision_id)) ?? headDecision ?? root;

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
          consequence_preview,
        };
      }
    }

    // optional: block if preview says BLOCK
    if (
      input.block_on_consequence_block === true &&
      consequence_preview.warnings.some((w) => w.severity === "BLOCK")
    ) {
      return {
        ok: false,
        decision: headDecision,
        violations: [
          {
            code: "CONSEQUENCE_BLOCKED",
            severity: "BLOCK",
            message: "Event blocked by consequence preview.",
          },
        ],
        consequence_preview,
      };
    }

    // 4) idempotency shortcut
    if (input.idempotency_key && store.findEventByIdempotencyKey) {
      const existing = await store.findEventByIdempotencyKey(
        input.decision_id,
        input.idempotency_key
      );

      if (existing) {
        // event already persisted; return current head
        await store.putDecision(headDecision);
        return {
          ok: true,
          decision: headDecision,
          warnings: headWarnings,
          consequence_preview,
        };
      }
    }

    // 5) append event
    await store.appendEvent(input.decision_id, {
      at: nowIso(opts),
      event: input.event,
      idempotency_key: input.idempotency_key,
    });

    // 6) replay delta (base -> all events up to now)
    const deltaAfter = await loadDeltaEvents(store, input.decision_id, baseSeq);
    const rr = replayDecision(baseDecision, deltaAfter.map((r) => r.event), opts);

    if (rr.ok === false) {
      return {
        ok: false,
        decision: rr.decision,
        violations: rr.violations,
        consequence_preview,
      };
    }

    await store.putDecision(rr.decision);

    // 7) snapshot + retention + anchors (optional)
    if (input.snapshotStore && input.snapshotPolicy) {
      const lastSeq = deltaAfter.length ? deltaAfter[deltaAfter.length - 1]!.seq : baseSeq;
      const lastSnapSeq = (snapshot as any)?.up_to_seq ?? 0;

      if (shouldCreateSnapshot(input.snapshotPolicy, lastSeq, lastSnapSeq)) {
        const lastRec = deltaAfter.length ? deltaAfter[deltaAfter.length - 1]! : null;
        const checkpoint_hash =
          lastRec && (lastRec as any).hash ? String((lastRec as any).hash) : null;

        // create snapshot
        await input.snapshotStore.putSnapshot({
          decision_id: input.decision_id,
          up_to_seq: lastSeq,
          decision: rr.decision,
          created_at: nowIso(opts),
          checkpoint_hash,
          state_hash: computeStateHash(rr.decision),
        } as any);

        // anchors (idempotent per snapshot)
        const anchorEnabled = input.anchorPolicy?.enabled ?? true;
        if (anchorEnabled && input.anchorStore) {
          const latest = await input.snapshotStore.getLatestSnapshot(input.decision_id);

          if (latest) {
            const aStore: any = input.anchorStore;

            const already =
              typeof aStore.getAnchorForSnapshot === "function"
                ? await aStore.getAnchorForSnapshot(input.decision_id, (latest as any).up_to_seq)
                : typeof aStore.findAnchorByCheckpoint === "function"
                  ? await aStore.findAnchorByCheckpoint(input.decision_id, (latest as any).up_to_seq)
                  : null;

            if (!already) {
              await input.anchorStore.appendAnchor({
                at: nowIso(opts),
                decision_id: input.decision_id,
                snapshot_up_to_seq: (latest as any).up_to_seq,
                checkpoint_hash: (latest as any).checkpoint_hash ?? null,
                root_hash: (latest as any).root_hash ?? null,
                state_hash: (latest as any).state_hash ?? computeStateHash(rr.decision),
              } as any);
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
              await input.snapshotStore.pruneEventsUpToSeq(
                input.decision_id,
                (latest as any).up_to_seq
              );
            }
          }
        }
      }
    }

    return {
      ok: true,
      decision: rr.decision,
      warnings: rr.warnings,
      consequence_preview,
    };
  });
}


