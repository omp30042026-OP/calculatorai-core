// packages/decision/src/store-engine.ts
import { createDecisionV2 } from "./decision.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionEngineOptions } from "./engine";
import { replayDecision } from "./engine";
import type { PolicyViolation } from "./policy.js";
import type { DecisionEventRecord, DecisionStore } from "./store.js";
import { applyDecisionEvent } from "./engine";
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

import {
  evaluateApprovalGates,
  type ApprovalGatePolicy,
  type GateDecisionContext,
} from "./approval-gates.js";

import {
  evaluateComplianceConstraints,
  type CompliancePolicy,
  type ComplianceContext,
} from "./compliance-constraints.js";

import {
  enforceImmutabilityWindow,
  type ImmutabilityPolicy,
} from "./immutability.js";

// ✅ Feature 8: External attestation
import type { Attestor } from "./attestation.js";
import {
  buildDecisionAttestationPayload,
  computePayloadHash,
} from "./attestation.js";

// ✅ Feature 11-x: ledger store + signer types (optional, no hard dependency)
import type { DecisionLedgerStore } from "./ledger-store.js";
import type { LedgerSigner } from "./ledger-signing.js";



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

function getMeta(obj: any): any {
  return obj && typeof obj === "object" ? obj : null;
}

function isApprovalLike(event: DecisionEvent): boolean {
  return event.type === "APPROVE" || event.type === "REJECT";
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
<<<<<<< HEAD
 * If store root is actually the head, rebuild canonical DRAFT root for replay.
=======
 * Store-backed apply:
 * V3 additions:
 * - optional optimistic locking via expected_current_version
 * - optional idempotency via idempotency_key (store may dedupe)
 * - optional atomic txn via store.runInTransaction
 *
 * Snapshot additions (read-path only):
 * - if store.getLatestSnapshot exists, replay starts from that snapshot
 * - if store.listEventsAfter exists, only reads events after snapshot seq
>>>>>>> origin/main
 */
function canonicalDraftRootFromStored(root: Decision): Decision {
  const created_at = root.created_at ?? new Date().toISOString();
  const nowFn = () => created_at;

  const d = createDecisionV2(
    {
      decision_id: root.decision_id,
      meta: root.meta ?? {},
      artifacts: root.artifacts ?? {},
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at };
}

/**
 * allow_locked_event_types is an ENGINE concern.
 * We derive it from immutabilityPolicy.allow_event_types if present.
 */
function lockedAllowlistFromInput(input: {
  immutabilityPolicy?: ImmutabilityPolicy;
}): Array<DecisionEvent["type"]> {
  const allow = input.immutabilityPolicy?.allow_event_types as
    | Array<DecisionEvent["type"]>
    | undefined;

  // Default: allow evidence + ingestion + external attestation after lock
  return allow ?? ["ATTACH_ARTIFACTS", "INGEST_RECORDS", "ATTEST_EXTERNAL"];
}

function bindDecisionId(d: Decision, decision_id: string): Decision {
  const anyD: any = d as any;
  if (anyD && typeof anyD.decision_id === "string" && anyD.decision_id.length) return d;
  return { ...(d as any), decision_id } as any;
}


// -----------------------------
// ✅ Feature 11-x: ledger emit helper
// - prefers input.ledgerStore if provided
// - otherwise falls back to store.appendLedgerEntry if present
// -----------------------------
async function emitLedger(
  store: DecisionStore,
  input: {
    ledgerStore?: DecisionLedgerStore;
    ledgerSigner?: LedgerSigner;
    tenant_id?: string | null;
  },
  entry: {
    at: string;
    type: "DECISION_EVENT_APPENDED" | "SNAPSHOT_CREATED" | "ANCHOR_APPENDED";
    decision_id: string | null;
    event_seq?: number | null;
    snapshot_up_to_seq?: number | null;
    anchor_seq?: number | null;
    payload: any;
  }
): Promise<void> {
  const ledger = input.ledgerStore;
  if (ledger && typeof ledger.appendLedgerEntry === "function") {
    await ledger.appendLedgerEntry({
      at: entry.at,
      tenant_id: input.tenant_id ?? null,
      type: entry.type,
      decision_id: entry.decision_id ?? null,
      event_seq: entry.event_seq ?? null,
      snapshot_up_to_seq: entry.snapshot_up_to_seq ?? null,
      anchor_seq: entry.anchor_seq ?? null,
      payload: entry.payload ?? null,
      signer: input.ledgerSigner,
    } as any);
    return;
  }

  // Back-compat: some users wire ledger directly onto DecisionStore (older MVP)
  const anyStore = store as any;
  if (typeof anyStore.appendLedgerEntry === "function") {
    await anyStore.appendLedgerEntry({
      at: entry.at,
      tenant_id: input.tenant_id ?? null,
      type: entry.type,
      decision_id: entry.decision_id ?? null,
      event_seq: entry.event_seq ?? null,
      snapshot_up_to_seq: entry.snapshot_up_to_seq ?? null,
      anchor_seq: entry.anchor_seq ?? null,
      payload: entry.payload ?? null,
      signer: input.ledgerSigner,
    });
  }
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

    anchorStore?: DecisionAnchorStore;
    anchorPolicy?: AnchorPolicy;

    anchorRetentionPolicy?: { keep_last_n_anchors: number };

    block_on_consequence_block?: boolean;

    gatePolicy?: ApprovalGatePolicy;
    gateContext?: GateDecisionContext;

    require_signer_identity_binding?: boolean;

    compliancePolicy?: CompliancePolicy;
    complianceContext?: ComplianceContext;

    immutabilityPolicy?: ImmutabilityPolicy;

    // ✅ Feature 8
    attestor?: Attestor;

    // ✅ Feature 11-x (tenant + signed ledger)
    tenant_id?: string | null;
    ledgerStore?: DecisionLedgerStore;
    ledgerSigner?: LedgerSigner;




    // ✅ Feature 12 (optional)
    responsibility?: {
      owner_id: string;
      owner_role?: string | null;
      org_id?: string | null;
      valid_from?: string | null;
      valid_to?: string | null;
    };

    approver?: {
      approver_id: string;
      approver_role?: string | null;
    };

    impact?: {
      estimated_cost?: number | null;
      currency?: string | null;
      risk_score?: number | null;
      regulatory_exposure?: "LOW" | "MEDIUM" | "HIGH" | null;
      notes?: string | null;
    };



  },
  opts: DecisionEngineOptions = {}
): Promise<StoreApplyResult> {
  const run = store.runInTransaction
    ? store.runInTransaction.bind(store)
    : async <T>(fn: () => Promise<T>) => fn();

  return run(async () => {
        // 1) ensure decision exists (create if missing)
    const rootMaybe = await store.getRootDecision(input.decision_id);

    let root: Decision;
    if (rootMaybe) {
      root = rootMaybe;
    } else {
      const nowFn = opts.now ?? (() => new Date().toISOString());

      root = createDecisionV2(
        {
          decision_id: input.decision_id,
          meta: input.metaIfCreate ?? {},
          artifacts: {},
          version: 1,
        } as any,
        nowFn
      ) as any;

      // belt-and-suspenders
      root = { ...root, decision_id: input.decision_id } as any;

      await store.createDecision(root);
      await store.putDecision(root);
    }

    // 2) load snapshot (optional)
    const snapshot = input.snapshotStore
      ? await input.snapshotStore.getLatestSnapshot(input.decision_id)
      : null;

    // base for replay
    const baseDecision = snapshot
      ? ((snapshot as any).decision as Decision)
      : canonicalDraftRootFromStored(root);

    const baseSeq = snapshot ? ((snapshot as any).up_to_seq ?? 0) : 0;

    // 3) compute current head
    const deltaBefore = await loadDeltaEvents(store, input.decision_id, baseSeq);
    const rrBefore = replayDecision(
      baseDecision,
      deltaBefore.map((r) => r.event),
      { ...opts, allow_locked_event_types: lockedAllowlistFromInput(input) }
    );

    if (rrBefore.ok === false) {
      return {
        ok: false,
        decision: rrBefore.decision,
        violations: rrBefore.violations,
      };
    }

    const headDecision = rrBefore.decision;
    const headWarnings = rrBefore.warnings;

    const consequence_preview = computeConsequencePreview({
      decision: headDecision ?? null,
      event: input.event,
    });

    // ✅ Feature 5
    const imm = enforceImmutabilityWindow({
      policy: input.immutabilityPolicy,
      decision: headDecision,
      event: input.event,
      nowIso: nowIso(opts),
    });

    if (!imm.ok) {
      return {
        ok: false,
        decision: headDecision,
        violations: imm.violations,
        consequence_preview,
      };
    }

    // 0) optimistic lock
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

    // ✅ Feature 2
    if (input.gatePolicy) {
      const gate = evaluateApprovalGates({
        policy: input.gatePolicy,
        decision: headDecision,
        event: input.event,
        ctx: input.gateContext,
      });

      if (!gate.ok) {
        return {
          ok: false,
          decision: headDecision,
          violations: gate.violations,
          consequence_preview,
        };
      }
    }

<<<<<<< HEAD
    // ✅ Feature 3
    if (input.require_signer_identity_binding === true && isApprovalLike(input.event)) {
      const meta = getMeta((input.event as any)?.meta) ?? {};
      const signer_id = typeof meta.signer_id === "string" ? meta.signer_id : null;
      const signer_state_hash =
        typeof meta.signer_state_hash === "string" ? meta.signer_state_hash : null;

      const persistedHead = (await store.getDecision(input.decision_id)) ?? headDecision;
      const expected_state_hash = computeStateHash(persistedHead);

      const violations: PolicyViolation[] = [];

      if (!signer_id) {
        violations.push({
          code: "SIGNER_ID_REQUIRED",
          severity: "BLOCK",
          message: "Signer identity binding required: meta.signer_id is missing.",
        });
      }

      if (!signer_state_hash) {
        violations.push({
          code: "SIGNER_STATE_HASH_REQUIRED",
          severity: "BLOCK",
          message: "Signer identity binding required: meta.signer_state_hash is missing.",
        });
      } else if (signer_state_hash !== expected_state_hash) {
        violations.push({
          code: "SIGNER_STATE_HASH_MISMATCH",
          severity: "BLOCK",
          message: "Signer identity binding failed: state hash does not match current decision state.",
        });
      }

      if (signer_id && signer_id !== (input.event as any).actor_id) {
        violations.push({
          code: "SIGNER_ACTOR_MISMATCH",
          severity: "BLOCK",
          message: "Signer identity binding failed: signer_id must match actor_id.",
        });
      }

      if (violations.length) {
        return { ok: false, decision: headDecision, violations, consequence_preview };
      }
    }

    // ✅ Feature 4
    if (input.compliancePolicy) {
      const cr = evaluateComplianceConstraints({
        policy: input.compliancePolicy,
        decision: headDecision,
        event: input.event,
        ctx: input.complianceContext,
      });

      if (!cr.ok) {
        return {
          ok: false,
          decision: headDecision,
          violations: cr.violations,
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

    // idempotency shortcut
=======
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
>>>>>>> origin/main
    if (input.idempotency_key && store.findEventByIdempotencyKey) {
      const existing = await store.findEventByIdempotencyKey(
        input.decision_id,
        input.idempotency_key
      );
      if (existing) {
<<<<<<< HEAD
        const toPersist = bindDecisionId(headDecision, input.decision_id);
        await store.putDecision(toPersist);
        return {
          ok: true,
          decision: toPersist,
          warnings: headWarnings,
          consequence_preview,
        };
=======
        // Event already appended previously → just materialize from base (snapshot/root)
        return replayFromBase();
>>>>>>> origin/main
      }
    }

    // ✅ Feature 8: enrich ATTEST_EXTERNAL event with payload+receipt
    let eventToAppend: DecisionEvent = input.event;

    if (input.attestor && input.event.type === "ATTEST_EXTERNAL") {
      const state_hash = computeStateHash(headDecision);

      const target =
        typeof (input.event as any).target === "string"
          ? ((input.event as any).target as "DECISION_STATE" | "SNAPSHOT" | "ANCHOR")
          : "DECISION_STATE";

      const snapshot_up_to_seq =
        typeof (input.event as any).snapshot_up_to_seq === "number"
          ? (input.event as any).snapshot_up_to_seq
          : undefined;

      const tags =
        (input.event as any).tags && typeof (input.event as any).tags === "object"
          ? ((input.event as any).tags as Record<string, string>)
          : undefined;

      const payload = buildDecisionAttestationPayload({
        decision: headDecision,
        state_hash,
        attested_at: nowIso(opts),
        target,
        snapshot_up_to_seq,
        tags,
      });

      const receipt = await input.attestor.attest(payload);

      const expected_payload_hash = computePayloadHash(payload);
      if (receipt.payload_hash && receipt.payload_hash !== expected_payload_hash) {
        return {
          ok: false,
          decision: headDecision,
          violations: [
            {
              code: "ATTESTATION_PAYLOAD_HASH_MISMATCH",
              severity: "BLOCK",
              message: "Attestation receipt payload_hash does not match expected payload hash.",
              details: {
                expected: expected_payload_hash,
                provided: receipt.payload_hash,
              } as any,
            },
          ],
          consequence_preview,
        };
      }

      eventToAppend = {
        ...(input.event as any),
        meta: {
          ...(((input.event as any).meta ?? {}) as any),
          payload,
          receipt,
        },
      } as any;
    }

    // ✅ PREVIEW APPLY (DO NOT PERSIST EVENT YET)
    // If this fails, we must NOT append the event to the store.
    const rrPreview = replayDecision(
      baseDecision,
      [...deltaBefore.map((r) => r.event), eventToAppend],
      { ...opts, allow_locked_event_types: lockedAllowlistFromInput(input) }
    );

    if (rrPreview.ok === false) {
      return {
        ok: false,
        decision: rrPreview.decision,
        violations: rrPreview.violations,
        consequence_preview,
      };
    }

    // ✅ NOW it's safe to persist the event
    const appended = await store.appendEvent(input.decision_id, {
      at: nowIso(opts),
      event: eventToAppend,
      idempotency_key: input.idempotency_key,
    });

<<<<<<< HEAD
    // ✅ Feature 11-x: ledger emit (only after successful apply preview)
    await emitLedger(
      store,
      { ledgerStore: input.ledgerStore, ledgerSigner: input.ledgerSigner, tenant_id: input.tenant_id ?? null },
      {
        at: nowIso(opts),
        type: "DECISION_EVENT_APPENDED",
        decision_id: input.decision_id,
        event_seq: appended.seq,
        payload: {
          event_type: eventToAppend.type,
          idempotency_key: input.idempotency_key ?? null,
          responsibility: input.responsibility ?? null,
          approver: input.approver ?? null,
          impact: input.impact ?? null,
        },
      }
    );

    // Persist the decision computed by the preview replay
    const toPersist = bindDecisionId(rrPreview.decision, input.decision_id);
    await store.putDecision(toPersist);

    // snapshots + anchors unchanged (but ledger emission upgraded)
    if (input.snapshotStore && input.snapshotPolicy) {
      const lastSeq = appended.seq;
      const lastSnapSeq = (snapshot as any)?.up_to_seq ?? 0;

      if (shouldCreateSnapshot(input.snapshotPolicy, lastSeq, lastSnapSeq)) {
        const lastRec: any = appended ?? null;
        const checkpoint_hash =
          lastRec && (lastRec as any).hash ? String((lastRec as any).hash) : null;

        await input.snapshotStore.putSnapshot({
          decision_id: input.decision_id,
          up_to_seq: lastSeq,
          decision: rrPreview.decision,
          created_at: nowIso(opts),
          checkpoint_hash,
          state_hash: computeStateHash(rrPreview.decision),
        } as any);

        // ledger: snapshot created
        await emitLedger(
          store,
          { ledgerStore: input.ledgerStore, ledgerSigner: input.ledgerSigner, tenant_id: input.tenant_id ?? null },
          {
            at: nowIso(opts),
            type: "SNAPSHOT_CREATED",
            decision_id: input.decision_id,
            snapshot_up_to_seq: lastSeq,
            payload: {
              checkpoint_hash,
              sstate_hash: computeStateHash(rrPreview.decision),

              // ✅ Feature 12 metadata
              responsibility: input.responsibility ?? null,
              approver: input.approver ?? null,
              impact: input.impact ?? null,
            },
          }
        );

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
              const anchorRec = await input.anchorStore.appendAnchor({
                at: nowIso(opts),
                decision_id: input.decision_id,
                snapshot_up_to_seq: (latest as any).up_to_seq,
                checkpoint_hash: (latest as any).checkpoint_hash ?? null,
                root_hash: (latest as any).root_hash ?? null,
                state_hash: (latest as any).state_hash ?? computeStateHash(rrPreview.decision),
              } as any);

              // ledger: anchor appended
              await emitLedger(
                store,
                { ledgerStore: input.ledgerStore, ledgerSigner: input.ledgerSigner, tenant_id: input.tenant_id ?? null },
                {
                  at: nowIso(opts),
                  type: "ANCHOR_APPENDED",
                  decision_id: input.decision_id,
                  snapshot_up_to_seq: (latest as any).up_to_seq,
                  anchor_seq: (anchorRec as any)?.seq ?? null,
                  payload: {
                    state_hash: (latest as any).state_hash ?? null,

                    // ✅ Feature 12 metadata
                    responsibility: input.responsibility ?? null,
                    approver: input.approver ?? null,
                    impact: input.impact ?? null,
                  },
                }
              );
            }

            const keepN = input.anchorRetentionPolicy?.keep_last_n_anchors;
            if (typeof keepN === "number" && typeof aStore.pruneAnchors === "function") {
              await aStore.pruneAnchors(keepN);
            }
          }
        }

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

        return { ok: true, decision: toPersist, warnings: rrPreview.warnings, consequence_preview };
=======
    // 4) replay -> materialize current (from snapshot/root)
    return replayFromBase();
>>>>>>> origin/main
  });
}

