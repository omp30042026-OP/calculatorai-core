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

import {
  applyProvenanceTransition,
  verifyProvenanceChain,
  migrateProvenanceChain,
} from "./provenance.js";

import type { HexHash } from "./snapshots.js";


import { createDefaultPolicyEngine } from "./policy-engine.js";
import { computeTrust, makeLiabilityReceipt } from "./trust-liability.js";
import { ensureEnterpriseTables } from "./enterprise-schema.js";
import { evaluateEventGate } from "./gates/evaluate-event-gate.js";


import {
  computeDecisionStateHash,
  stripNonStateFieldsForHash,
  computeTamperStateHash,
  computePublicStateHash,
} from "./state-hash.js";

import { enforceTrustBoundary as enforceTrustBoundaryV2, type TrustBoundaryPolicy } from "./trust-boundary.js";


import type { SignerDirectory } from "./signer-binding.js";
import { verifySignerBindingAsync } from "./signer-binding.js";







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

function computeReceiptHashV1(params: {
  decision_id: string;
  event_seq: number;
  event_type: string;
  actor_id: string;
  actor_type: string;
  trust_score: number;
  trust_reason: string | null;

  state_before_hash: string | null;
  state_after_hash: string | null;

  public_state_before_hash: string | null;
  public_state_after_hash: string | null;

  obligations_hash: string | null;
  created_at: string;
}): string {
  return sha256Hex(
    stableStringify({
      kind: "LIABILITY_RECEIPT_HASH_V1",
      decision_id: params.decision_id,
      event_seq: params.event_seq,
      event_type: params.event_type,
      actor_id: params.actor_id,
      actor_type: params.actor_type,
      trust_score: params.trust_score,
      trust_reason: params.trust_reason,

      state_before_hash: params.state_before_hash,
      state_after_hash: params.state_after_hash,

      public_state_before_hash: params.public_state_before_hash,
      public_state_after_hash: params.public_state_after_hash,

      obligations_hash: params.obligations_hash,
      created_at: params.created_at,
    })
  );
}


function computeDecisionEdgeHash(params: {
  from_decision_id: string;
  to_decision_id: string;
  relation: string;
  via_event_seq: number;
  meta_json: string | null;
}): string {
  return sha256Hex(
    stableStringify({
      kind: "DECISION_EDGE_V1",
      from_decision_id: params.from_decision_id,
      to_decision_id: params.to_decision_id,
      relation: params.relation,
      via_event_seq: params.via_event_seq,
      meta_json: params.meta_json,
    })
  );
}


function extractDagEdgesFromEvent(params: {
  decision_id: string;
  event: any;
}): Array<{
  from_decision_id: string;
  to_decision_id: string;
  relation: string;
  meta: any | null;
}> {
  const { decision_id, event } = params;

  // ✅ Feature 14: canonical DAG edges come from LINK_DECISIONS
  if (event?.type !== "LINK_DECISIONS") return [];

  const links = Array.isArray(event?.links) ? event.links : [];
  const out: any[] = [];

  for (const l of links) {
    const to_decision_id =
      typeof l?.to_decision_id === "string" && l.to_decision_id.length
        ? String(l.to_decision_id)
        : null;

    const relation =
      typeof l?.relation === "string" && l.relation.length
        ? String(l.relation)
        : null;

    if (!to_decision_id || !relation) continue;

    // meta is stable-stringified before hashing
    const meta =
      l?.note != null || l?.confidence != null
        ? { note: l?.note ?? null, confidence: l?.confidence ?? null }
        : null;

    out.push({
      from_decision_id: decision_id,
      to_decision_id,
      relation, // keep as-is: DEPENDS_ON / BLOCKS / DUPLICATES / DERIVES_FROM / RELATED_TO
      meta,
    });
  }

  return out;
}





// ✅ Feature 22: verify signatures + detect DB tamper (read/replay guard)
function verifyRiskLiabilityIntegrityOrThrow(params: {
  store: DecisionStore;
  decision_id: string;
  db: any;
  // what is stored in decisions.decision_json (can drift)
  persistedDecision: any;
  // canonical head reconstructed from events (should match receipts)
  canonicalDecision: any;
}): PolicyViolation[] {
  const { decision_id, db, persistedDecision, canonicalDecision } = params;
  if (!db) return [];

  try {
    // ✅ verify receipts against canonical replay head (NOT persisted blob)
    // Raw decision (what engine reconstructed or loaded)
    // We are verifying DB integrity, so hash the *persisted* decision blob.
    // Canonical replay is only for diagnostics / comparison.
    const persistedForCheckRaw = persistedDecision ?? canonicalDecision;
    const canonicalForCheckRaw = canonicalDecision ?? persistedDecision;

    const persistedForCheck = stripNonStateFieldsForHash(persistedForCheckRaw);
    const canonicalForCheck = stripNonStateFieldsForHash(canonicalForCheckRaw);

    // 1) Detect decision_json tamper vs latest receipt hashes
    const lastReceipt = db
      .prepare(
        `SELECT event_seq, receipt_hash, state_after_hash, public_state_after_hash
         FROM liability_receipts
         WHERE decision_id=?
         ORDER BY event_seq DESC
         LIMIT 1`
      )
      .get(decision_id);

    if (!lastReceipt) return [];

    const expectedPublic =
      lastReceipt.public_state_after_hash != null ? String(lastReceipt.public_state_after_hash) : null;

    const expectedTamper =
      lastReceipt.state_after_hash != null ? String(lastReceipt.state_after_hash) : null;

    // LEGACY DETECTION:
    // Legacy = no public hash column populated.
    const isLegacySingleHash = !expectedPublic;

    if (isLegacySingleHash) {
      if (!expectedTamper) return [];

      const legacyExpected = String(expectedTamper);
      const candidates: Array<{ mode: string; hash: string }> = [];

      // 1) current tamper semantics
      try {
        candidates.push({
          mode: "LEGACY_TAMPER_V_CURRENT",
          hash: computeTamperStateHash(persistedForCheck as any),
        });
      } catch (e) {}

      // 2) current public semantics (some legacy DBs used that)
      try {
        candidates.push({
          mode: "LEGACY_PUBLIC_V_CURRENT",
          hash: computePublicStateHash(persistedForCheck as any),
        });
      } catch (e) {}

      // 3) strict legacy semantics
      // NOTE: if you already have a strict legacy hash function in this file, call it here.
      // If you do NOT have it, you can omit this candidate.
      try {
        // If you have something like computeLegacyStrictStateHash, use it:
        // candidates.push({ mode: "LEGACY_STRICT_STATE_HASH", hash: computeLegacyStrictStateHash(decisionForReceiptCheck as any) });
      } catch (e) {}

      const ok = candidates.some((c) => c.hash === legacyExpected);
      if (!ok) {
        return [
          {
            code: "DECISION_TAMPERED_LEGACY",
            severity: "BLOCK",
            message:
              "Decision hash mismatch (legacy receipt): canonical decision does not match latest legacy state_after_hash.",
            details: {
              decision_id,
              latest_event_seq: Number(lastReceipt?.event_seq ?? 0),
              expected_state_after_hash: legacyExpected,
              computed_candidates: candidates,
              receipt_hash: String(lastReceipt?.receipt_hash ?? ""),
              mode: "LEGACY_SINGLE_HASH",
            } as any,
          },
        ];
      }
    } else {
      // ✅ DUAL HASH path (public hash is authoritative)
      const computedPublic = computePublicStateHash(persistedForCheck as any);

      if (String(computedPublic) !== String(expectedPublic)) {
        return [
          {
            code: "DECISION_PUBLIC_HASH_MISMATCH",
            severity: "BLOCK",
            message:
              "Decision public hash mismatch: stored decision does not match the latest public_state_after_hash receipt.",
            details: {
              decision_id,
              latest_event_seq: Number(lastReceipt?.event_seq ?? 0),
              expected_public_state_after_hash: String(expectedPublic),
              computed_public_state_hash: String(computedPublic),
              receipt_hash: String(lastReceipt?.receipt_hash ?? ""),
              mode: "DUAL_HASH_PUBLIC",
            } as any,
          },
        ];
      }

      // Optional: also assert tamper hash matches, if present
      if (expectedTamper) {
        const computedTamper = computeTamperStateHash(persistedForCheck as any);
        if (String(computedTamper) !== String(expectedTamper)) {
          return [
            {
              code: "DECISION_TAMPERED",
              severity: "BLOCK",
              message:
                "Decision tamper hash mismatch: canonical decision does not match latest state_after_hash receipt.",
              details: {
                decision_id,
                latest_event_seq: Number(lastReceipt?.event_seq ?? 0),
                expected_state_after_hash: String(expectedTamper),
                computed_tamper_state_hash: String(computedTamper),
                receipt_hash: String(lastReceipt?.receipt_hash ?? ""),
                mode: "DUAL_HASH_TAMPER",
              } as any,
            },
          ];
        }
      }
    }

    return [];
  } catch (e) {
    return [
      {
        code: "LIABILITY_VERIFY_FAILED",
        severity: "BLOCK",
        message: "Liability integrity verification failed (unable to verify safely).",
        details: { decision_id, error: String((e as any)?.message ?? e) } as any,
      },
    ];
  }
}




function readCanonicalAmountFromDecision(decision: any): { value: number | null; currency: string | null } {
  const a =
    decision?.fields?.amount ??
    decision?.amount ??
    decision?.artifacts?.extra?.amount ??
    decision?.artifacts?.amount ??
    null;

  if (!a || typeof a !== "object") return { value: null, currency: null };

  const v = typeof a.value === "number" ? a.value : Number(a.value);
  const value = Number.isFinite(v) ? v : null;
  const currency =
    typeof (a as any).currency === "string" && (a as any).currency.length
      ? String((a as any).currency)
      : "USD";

  return { value, currency: currency ?? null };
}

function computeRiskLiabilitySignaturePayload(params: {
  decision_id: string;
  event_seq: number;
  event_type: string;
  actor_id: string;
  actor_type: string;

  receipt_hash: string | null;
  state_before_hash: string | null;
  state_after_hash: string | null;
  obligations_hash: string | null;

  amount_value: number | null;
  amount_currency: string | null;

  responsibility: any | null;
  approver: any | null;
  impact: any | null;

  created_at: string;
}) {
  // Keep this payload STABLE + deterministic (only include canonical fields).
  return {
    kind: "RISK_LIABILITY_SIGNATURE_V1",
    decision_id: params.decision_id,
    event_seq: params.event_seq,
    event_type: params.event_type,
    actor_id: params.actor_id,
    actor_type: params.actor_type,

    receipt_hash: params.receipt_hash,
    state_before_hash: params.state_before_hash,
    state_after_hash: params.state_after_hash,
    obligations_hash: params.obligations_hash,

    amount: params.amount_value == null ? null : { value: params.amount_value, currency: params.amount_currency ?? "USD" },

    responsibility: params.responsibility ?? null,
    approver: params.approver ?? null,
    impact: params.impact ?? null,

    created_at: params.created_at,
  };
}




function extractAmountForWorkflow(decisionObj: any): { value?: number; currency?: string } | null {
  return (
    decisionObj?.fields?.amount ??
    decisionObj?.amount ??
    decisionObj?.artifacts?.extra?.amount ??
    null
  );
}

function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}




function getProvenanceTailHashFromDecision(decision: any): string | null {
  const a = decision?.artifacts ?? {};
  const extra = a?.extra ?? {};
  const bag = a.provenance ?? extra.provenance ?? null;
  const tail =
    bag && typeof bag === "object"
      ? (typeof bag.last_node_hash === "string" ? bag.last_node_hash : null)
      : null;
  return tail ?? null;
}

async function loadEventRecordAtSeq(
  store: DecisionStore,
  decision_id: string,
  seq: number
): Promise<DecisionEventRecord | null> {
  if (!Number.isFinite(seq) || seq <= 0) return null;

  // ✅ FAST PATH (your store.ts already supports this)
  if (typeof store.getEventBySeq === "function") {
    return (await store.getEventBySeq(decision_id, seq)) ?? null;
  }

  // fallback (older stores)
  const all = await store.listEvents(decision_id);
  return all.find((r) => r.seq === seq) ?? null;
}

async function verifySnapshotCheckpointOrThrow(params: {
  store: DecisionStore;
  decision_id: string;
  snapshot: any; // DecisionSnapshot-ish
}): Promise<void> {
  const { store, decision_id, snapshot } = params;

  if (!snapshot) return;

  const upToSeq = Number(snapshot.up_to_seq ?? 0);
  const checkpoint = snapshot.checkpoint_hash ?? null;

  // If snapshot has no checkpoint hash or seq<=0, nothing to verify.
  if (!checkpoint || !Number.isFinite(upToSeq) || upToSeq <= 0) return;

  const rec = await loadEventRecordAtSeq(store, decision_id, upToSeq);

  // ✅ Events may be pruned. If we already have a checkpoint hash stored in the snapshot,
  // we can still consider the snapshot valid even if the event row is missing.
  if (!rec) {
    return;
  }

  const eventHash = rec.hash ?? null;

  // If event exists but store doesn't provide hashes, we can't verify—treat as unverifiable (not fatal).
  if (!eventHash) {
    return;
  }

  // Best-effort: if mismatch, do NOT hard-fail.
  // Snapshot integrity is enforced via state_hash + provenance verification.
  if (eventHash !== checkpoint) {
    return;
  }

  const snapTail = snapshot.provenance_tail_hash ?? null;
  const decisionTail =
    snapshot?.decision?.artifacts?.extra?.provenance?.last_node_hash ??
    snapshot?.decision?.artifacts?.provenance?.last_node_hash ??
    null;

  if (snapTail && decisionTail && snapTail !== decisionTail) {
    throw new Error("SNAPSHOT_PROVENANCE_TAIL_MISMATCH");
  }

}



async function verifyLoadedSnapshotOrThrow(
  store: DecisionStore,
  decision_id: string,
  snapshot: any
): Promise<PolicyViolation[] /* empty = ok */> {
  if (!snapshot) return [];

  const snapDecision = snapshot.decision as any;
  const snapSeq = Number(snapshot.up_to_seq ?? 0);

  // 1) Provenance chain must be internally consistent
  const provOk = verifyProvenanceChain(snapDecision);
  if (!provOk.ok) {
    return [
      {
        code: "SNAPSHOT_TAMPERED",
        severity: "BLOCK",
        message: `Snapshot provenance invalid: ${provOk.code}: ${provOk.message}`,
        details: provOk as any,
      },
    ];
  }

  // 2) state_hash must match snapshot.decision
  const expectedStateHash = computeDecisionStateHash(snapDecision);
  const storedStateHash =
    typeof snapshot.state_hash === "string" ? snapshot.state_hash : null;

  if (storedStateHash && storedStateHash !== expectedStateHash) {
    return [
      {
        code: "SNAPSHOT_STATE_HASH_MISMATCH",
        severity: "BLOCK",
        message: "Snapshot state_hash does not match snapshot decision contents.",
        details: { stored: storedStateHash, expected: expectedStateHash } as any,
      },
    ];
  }

  // 3) provenance_tail_hash must match the decision’s provenance tail
  const expectedTail = getProvenanceTailHashFromDecision(snapDecision);
  const storedTail =
    typeof snapshot.provenance_tail_hash === "string"
      ? snapshot.provenance_tail_hash
      : null;

  if (storedTail && storedTail !== expectedTail) {
    return [
      {
        code: "SNAPSHOT_PROVENANCE_TAIL_MISMATCH",
        severity: "BLOCK",
        message: "Snapshot provenance_tail_hash does not match snapshot decision provenance tail.",
        details: { stored: storedTail, expected: expectedTail } as any,
      },
    ];
  }

  // 4) checkpoint_hash must match the event record at up_to_seq (if we can check)
  const storedCheckpoint =
    typeof snapshot.checkpoint_hash === "string" ? snapshot.checkpoint_hash : null;

  if (storedCheckpoint && snapSeq > 0) {
    const rec = await loadEventRecordAtSeq(store, decision_id, snapSeq);

    // only check if your event store actually provides hashes
    const eventHash =
      rec && (rec as any).hash ? String((rec as any).hash) : null;

    // Best-effort only (do not BLOCK).
    // We enforce snapshot integrity via state_hash + provenance chain.
    if (eventHash && storedCheckpoint !== eventHash) {
      return [];
    }
  }

  return [];
}



function getMeta(obj: any): any {
  return obj && typeof obj === "object" ? obj : null;
}

function isApprovalLike(event: DecisionEvent): boolean {
  return event.type === "APPROVE" || event.type === "REJECT";
}



function hasAnyRole(roles: string[], allowed: string[]) {
  const s = new Set(roles.map(String));
  return allowed.some((r) => s.has(r));
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
 * If store root is actually the head, rebuild canonical DRAFT root for replay.
 */
function canonicalDraftRootFromStored(root: Decision): Decision {
  const created_at = root.created_at ?? "1970-01-01T00:00:00.000Z";
  const nowFn = () => created_at;

  // IMPORTANT:
  // Root must be "genesis clean" for deterministic replay.
  // Do NOT carry over derived artifacts like provenance/history/etc.
  const d = createDecisionV2(
    {
      decision_id: root.decision_id,
      parent_decision_id: (root as any).parent_decision_id ?? undefined, // ✅ ADD THIS
      meta: root.meta ?? {},
      artifacts: {}, // genesis clean
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at } as any;
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

function getDecisionTrustPolicy(decision: Decision): any | null {
  const a: any = decision.artifacts ?? {};
  const extra: any = a.extra ?? {};
  const trust = extra.trust && typeof extra.trust === "object" ? extra.trust : null;
  const policy = trust?.policy ?? null;
  return policy && typeof policy === "object" ? policy : null;
}

function trustViolation(code: string, message: string, details?: any): PolicyViolation {
  return { code, severity: "BLOCK", message, details };
}

function enforceTrustBoundaryLegacy(params: {
  decision: Decision;
  event: DecisionEvent;
  trustContext?: any;
}): PolicyViolation[] {
  const { decision, event, trustContext } = params;

  const policy = getDecisionTrustPolicy(decision);
  if (!policy) return []; // no policy => allow (foundation behavior)

  if (policy.enabled === false) return [];

  const exempt: string[] = Array.isArray(policy.exempt_event_types)
    ? policy.exempt_event_types.map(String)
    : [];

  if (exempt.includes(event.type)) return [];

  const requireZone = policy.require_origin_zone === true;

  // Determine origin zone: prefer event.trust.origin.zone, else trustContext.origin_zone
  const evTrust: any = (event as any)?.trust ?? {};
  const origin: any = evTrust?.origin ?? null;
  const zone =
    (origin && typeof origin.zone === "string" ? origin.zone : null) ??
    (typeof trustContext?.origin_zone === "string" ? trustContext.origin_zone : null);

  if (requireZone && !zone) {
    return [
      trustViolation(
        "TRUST_ORIGIN_ZONE_REQUIRED",
        "Trust boundary policy requires origin zone for this event.",
        { event_type: event.type }
      ),
    ];
  }

  if (zone) {
    const denied = Array.isArray(policy.denied_origin_zones)
      ? policy.denied_origin_zones.map(String)
      : [];
    if (denied.includes(zone)) {
      return [
        trustViolation(
          "TRUST_ORIGIN_ZONE_DENIED",
          `Origin zone '${zone}' is denied by trust policy.`,
          { zone, event_type: event.type }
        ),
      ];
    }

    const allowed = Array.isArray(policy.allowed_origin_zones)
      ? policy.allowed_origin_zones.map(String)
      : [];

    // If allowed list is non-empty, enforce membership
    if (allowed.length > 0 && !allowed.includes(zone)) {
      return [
        trustViolation(
          "TRUST_ORIGIN_ZONE_NOT_ALLOWED",
          `Origin zone '${zone}' is not allowed by trust policy.`,
          { zone, allowed, event_type: event.type }
        ),
      ];
    }
  }

  return [];
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


// =====================================
// ✅ Feature 16-C: Persist Counterfactual Branch (materialize what-if)
// =====================================

export type PersistCounterfactualBranchInput = {
  // source (existing) decision
  decision_id: string;

  // new (branch) decision id to create
  new_decision_id: string;

  // optional horizon
  up_to_seq?: number;

  // optional snapshot acceleration (same store you already use)
  snapshotStore?: DecisionSnapshotStore;

  // the edits to apply (same shape as replayCounterfactualWithStore)
  edits: CounterfactualEdits;

  // optional metadata to stamp on the new branch decision
  meta?: Record<string, unknown>;

  // optional: reuse your stores/policies in applyEventWithStore
  snapshotPolicy?: SnapshotPolicy;
  snapshotRetentionPolicy?: SnapshotRetentionPolicy;

  anchorStore?: DecisionAnchorStore;
  anchorPolicy?: AnchorPolicy;
  anchorRetentionPolicy?: { keep_last_n_anchors: number };

  tenant_id?: string | null;
  ledgerStore?: DecisionLedgerStore;
  ledgerSigner?: LedgerSigner;

  // If true, bypass enterprise gates (recommended for offline “what-if” materialization)
  internal_bypass_enterprise_gates?: boolean;

  // If true, enforce trust boundary checks. Default: false (do NOT enforce)
  enforce_trust_boundary?: boolean;
};

export type PersistCounterfactualBranchResult =
  | {
      ok: true;
      source_decision_id: string;
      branch_decision_id: string;
      applied_events: number;
      baseline: { up_to_seq: number; base_seq: number; latest_seq: number; decision: Decision };
      counterfactual: { up_to_seq: number; decision: Decision };
      warnings: PolicyViolation[];
      used: CounterfactualResult["used"];
    }
  | {
      ok: false;
      source_decision_id: string;
      branch_decision_id: string;
      applied_events: number;
      baseline: { up_to_seq: number; base_seq: number; latest_seq: number; decision: Decision };
      counterfactual: { up_to_seq: number; decision: Decision };
      violations: PolicyViolation[];
      used: CounterfactualResult["used"];
    };





function cloneEventForAppend(ev: DecisionEvent): DecisionEvent {
  // keep deterministic replay + remove shared refs
  return JSON.parse(JSON.stringify(ev));
}

async function buildCounterfactualEventListWithStore(
  store: DecisionStore,
  input: {
    decision_id: string;
    up_to_seq?: number;
    snapshotStore?: DecisionSnapshotStore;
    edits: CounterfactualEdits;
  },
  opts: DecisionEngineOptions = {}
): Promise<{
  baseDecision: Decision;
  baseSeq: number;
  latestSeq: number;
  upto: number;
  baselineEvents: DecisionEvent[];
  counterfactualEvents: DecisionEvent[];
  used: CounterfactualResult["used"];
}> {
  const decision_id = input.decision_id;

  const rootMaybe = await store.getRootDecision(decision_id);
  if (!rootMaybe) {
    throw new Error("DECISION_NOT_FOUND");
  }

  const snapshot = input.snapshotStore
    ? await input.snapshotStore.getLatestSnapshot(decision_id)
    : null;

  const baseDecision = snapshot
    ? ((snapshot as any).decision as Decision)
    : canonicalDraftRootFromStored(rootMaybe);

  const baseSeq = snapshot ? Number((snapshot as any).up_to_seq ?? 0) : 0;

  const tailAll = await loadDeltaEvents(store, decision_id, baseSeq);
  const latestSeq = tailAll.length ? Number(tailAll[tailAll.length - 1]!.seq) : baseSeq;

  const requestedUpto =
    typeof input.up_to_seq === "number" ? Math.floor(input.up_to_seq) : latestSeq;

  const upto = Math.max(baseSeq, Math.min(requestedUpto, latestSeq));

  const baselineEvents = tailAll
    .filter((r) => r.seq <= upto)
    .map((r) => r.event);

  // replace map
  const replaceMap = new Map<number, { event: DecisionEvent; keep_original_at: boolean }>();
  for (const r of input.edits.replace ?? []) {
    if (!Number.isFinite(r.seq) || r.seq <= 0) continue;
    replaceMap.set(Math.floor(r.seq), {
      event: r.event,
      keep_original_at: r.keep_original_at !== false,
    });
  }

  const truncAfter =
    typeof input.edits.truncate_after_seq === "number"
      ? Math.floor(input.edits.truncate_after_seq)
      : null;

  const cfEvents: DecisionEvent[] = [];
  for (const rec of tailAll) {
    if (rec.seq > upto) break;
    if (truncAfter != null && rec.seq > truncAfter) break;

    const rep = replaceMap.get(rec.seq);
    if (!rep) {
      cfEvents.push(rec.event);
      continue;
    }

    const originalAt = (rec.event as any)?.at;
    const patched = rep.keep_original_at && originalAt
      ? ({ ...(rep.event as any), at: originalAt } as any)
      : (rep.event as any);

    cfEvents.push(patched as any);
  }

  // append extra events (stamp at deterministically if missing)
  const append = Array.isArray(input.edits.append) ? input.edits.append : [];
  const appendStamped = append.map((ev) => {
    const hasAt = typeof (ev as any)?.at === "string" && (ev as any).at.length > 0;
    return hasAt ? ev : ({ ...(ev as any), at: nowIso(opts) } as any);
  });

  cfEvents.push(...appendStamped);

  const used = {
    base_seq: baseSeq,
    latest_seq: latestSeq,
    replaced_seqs: Array.from(replaceMap.keys()).sort((a, b) => a - b),
    truncated_after_seq: truncAfter,
    appended_count: appendStamped.length,
  };

  return {
    baseDecision,
    baseSeq,
    latestSeq,
    upto,
    baselineEvents,
    counterfactualEvents: cfEvents,
    used,
  };
}

export async function persistCounterfactualBranchWithStore(
  store: DecisionStore,
  input: PersistCounterfactualBranchInput,
  opts: DecisionEngineOptions = {}
): Promise<PersistCounterfactualBranchResult> {
  const sourceId = input.decision_id;
  const branchId = input.new_decision_id;

  // 1) compute baseline + counterfactual decisions (pure, no writes)
  let plan: Awaited<ReturnType<typeof buildCounterfactualEventListWithStore>>;
  try {
    plan = await buildCounterfactualEventListWithStore(
      store,
      {
        decision_id: sourceId,
        up_to_seq: input.up_to_seq,
        snapshotStore: input.snapshotStore,
        edits: input.edits,
      },
      opts
    );
  } catch (e) {
    const d = createDecisionV2(
      { decision_id: sourceId, meta: {}, artifacts: {}, version: 1 } as any,
      () => nowIso(opts)
    ) as any;

    return {
      ok: false,
      source_decision_id: sourceId,
      branch_decision_id: branchId,
      applied_events: 0,
      baseline: { up_to_seq: 0, base_seq: 0, latest_seq: 0, decision: d as any },
      counterfactual: { up_to_seq: 0, decision: d as any },
      violations: [
        { code: "DECISION_NOT_FOUND", severity: "BLOCK", message: "Source decision does not exist." },
      ],
      used: {
        base_seq: 0,
        latest_seq: 0,
        replaced_seqs: [],
        truncated_after_seq: null,
        appended_count: 0,
      },
    };
  }

  // --- normalize events for replay (some callers use { type } instead of { event_type }) ---
  const normalizeForReplay = (ev: any) => {
    if (ev == null) return ev;

    const hasEventType = typeof ev.event_type === "string" && ev.event_type.length > 0;
    const hasType = typeof ev.type === "string" && ev.type.length > 0;

    // Make replay robust: satisfy either engine convention by ensuring both fields exist.
    if (hasEventType && !hasType) return { ...ev, type: ev.event_type };
    if (hasType && !hasEventType) return { ...ev, event_type: ev.type };

    return ev;
  };
  const baselineEventsForReplay = plan.baselineEvents.map(normalizeForReplay);
  const cfEventsForReplay = plan.counterfactualEvents.map(normalizeForReplay);

  const rrBaseline = replayDecision(
    plan.baseDecision,
    baselineEventsForReplay,
    { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
  );

  const rrCF = replayDecision(
    plan.baseDecision,
    cfEventsForReplay,
    { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
  );

  const baselineDecision = rrBaseline.decision;
  const cfDecision = rrCF.decision;

  // 2) create branch root
  const existingBranch = await store.getRootDecision(branchId);
  if (existingBranch) {
    return {
      ok: false,
      source_decision_id: sourceId,
      branch_decision_id: branchId,
      applied_events: 0,
      baseline: { up_to_seq: plan.upto, base_seq: plan.baseSeq, latest_seq: plan.latestSeq, decision: baselineDecision },
      counterfactual: { up_to_seq: plan.upto, decision: cfDecision },
      violations: [
        {
          code: "BRANCH_ALREADY_EXISTS",
          severity: "BLOCK",
          message: `Branch decision_id already exists: ${branchId}`,
        },
      ],
      used: plan.used,
    };
  }

  const sourceRoot = await store.getRootDecision(sourceId);
  const createdAt = nowIso(opts);

  const branchRoot = createDecisionV2(
    {
      decision_id: branchId,
      parent_decision_id: sourceId,
      meta: {
        ...(sourceRoot?.meta ?? {}),
        ...(input.meta ?? {}),
        counterfactual_of: sourceId,
        counterfactual_created_at: createdAt,
        counterfactual_upto_seq: plan.upto,
        counterfactual_base_seq: plan.baseSeq,
      },
      artifacts: {}, // keep genesis clean
      version: 1,
    } as any,
    () => createdAt
  ) as any;

  await store.createDecision(branchRoot as any);
  await store.putDecision(branchRoot as any);

  // 3) materialize by applying planned counterfactual event list onto the new branch decision
  let applied = 0;
  let warnings: PolicyViolation[] = [];
  for (const ev of plan.counterfactualEvents) {
    const r = await applyEventWithStore(
      store,
      {
        decision_id: branchId,
        event: cloneEventForAppend(ev),

        // reuse infra if provided
        snapshotStore: input.snapshotStore,
        snapshotPolicy: input.snapshotPolicy,
        snapshotRetentionPolicy: input.snapshotRetentionPolicy,
        anchorStore: input.anchorStore,
        anchorPolicy: input.anchorPolicy,
        anchorRetentionPolicy: input.anchorRetentionPolicy,

        tenant_id: input.tenant_id ?? null,
        ledgerStore: input.ledgerStore,
        ledgerSigner: input.ledgerSigner,

        // default: bypass enterprise gates for deterministic offline branch creation
        internal_bypass_enterprise_gates: input.internal_bypass_enterprise_gates !== false,

        // default: do NOT enforce trust boundary on branch materialization
        enforce_trust_boundary: input.enforce_trust_boundary === true,
      } as any,
      opts
    );

    applied++;

    if (!r.ok) {
      const finalBranch = (await store.getDecision(branchId)) ?? branchRoot;
      return {
        ok: false,
        source_decision_id: sourceId,
        branch_decision_id: branchId,
        applied_events: applied,
        baseline: { up_to_seq: plan.upto, base_seq: plan.baseSeq, latest_seq: plan.latestSeq, decision: baselineDecision },
        counterfactual: { up_to_seq: plan.upto, decision: finalBranch },
        violations: r.violations,
        used: plan.used,
      };
    }

    warnings = [...warnings, ...(r.warnings ?? [])];
  }

  const finalBranch = (await store.getDecision(branchId)) ?? branchRoot;

  // 4) build an in-memory "materialized" view by replaying branch events
  // (some stores return the genesis snapshot from getDecision; replay guarantees latest state)
  const branchEventRecs = await store.listEvents(branchId);

  const branchEventsForReplay = branchEventRecs
    .map((r: any) => r?.event ?? r) // supports stores that return {event, seq, hash,...} OR raw events
    .map(normalizeForReplay);

  const rrBranch = replayDecision(
    branchRoot as any,
    branchEventsForReplay as any,
    { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
  );

  const materializedBranch = rrBranch.decision as any;

  return {
    ok: rrCF.ok !== false && rrBaseline.ok !== false,
    source_decision_id: sourceId,
    branch_decision_id: branchId,
    applied_events: applied,
    baseline: { up_to_seq: plan.upto, base_seq: plan.baseSeq, latest_seq: plan.latestSeq, decision: baselineDecision },
    counterfactual: { up_to_seq: plan.upto, decision: materializedBranch },
    warnings: [...(rrBaseline.ok ? (rrBaseline.warnings ?? []) : []), ...(rrCF.ok ? (rrCF.warnings ?? []) : []), ...warnings],
    used: plan.used,
  } as any;
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




function computeMerkleRootFromEventHashes(hashes: Array<HexHash | null | undefined>): HexHash | null {
  const clean = hashes.filter((h): h is HexHash => typeof h === "string" && h.length > 0);
  if (clean.length === 0) return null;

  let level = clean.map((h) => sha256Hex(`leaf:${h}`));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i];
      next.push(sha256Hex(`node:${a}:${b}`));
    }
    level = next;
  }
  return (level[0] ?? null) as any;
}

async function loadEventHashesUpToSeqBestEffort(
  store: DecisionStore,
  decision_id: string,
  up_to_seq: number
): Promise<Array<HexHash | null>> {
  if (!Number.isFinite(up_to_seq) || up_to_seq <= 0) return [];

  // FAST PATH: if store can fetch by seq
  if (typeof (store as any).getEventBySeq === "function") {
    const out: Array<HexHash | null> = [];
    for (let seq = 1; seq <= up_to_seq; seq++) {
      const rec = await (store as any).getEventBySeq(decision_id, seq);
      out.push(rec?.hash ? String(rec.hash) : null);
    }
    return out;
  }

  // fallback: list all events
  const all = await store.listEvents(decision_id);
  const bySeq = new Map<number, any>();
  for (const r of all) bySeq.set(Number((r as any).seq ?? 0), r);

  const out: Array<HexHash | null> = [];
  for (let seq = 1; seq <= up_to_seq; seq++) {
    const rec = bySeq.get(seq);
    out.push(rec?.hash ? String(rec.hash) : null);
  }
  return out;
}
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
    require_liability_shield?: boolean;

    compliancePolicy?: CompliancePolicy;
    complianceContext?: ComplianceContext;

    immutabilityPolicy?: ImmutabilityPolicy;

    require_risk_liability_signature?: boolean;

    // ✅ Feature 8
    attestor?: Attestor;

    // ✅ Feature 11-x (tenant + signed ledger)
    tenant_id?: string | null;
    ledgerStore?: DecisionLedgerStore;
    ledgerSigner?: LedgerSigner;

    

    // ✅ Feature 17: Trust boundary foundation
    trustContext?: {
      origin_zone?: string | null;   // e.g. "PARTNER"
      origin_system?: string | null; // e.g. "lightspeed"
      channel?: string | null;       // e.g. "api" | "ui" | "batch"
      tenant_id?: string | null;     // optional
    };

    enforce_trust_boundary?: boolean;

    // ✅ Feature 19: signer binding directory (public keys)
    signerDirectory?: SignerDirectory;

    // ✅ Internal: allow system / migrations / commitCounterfactual to bypass enterprise gates
    internal_bypass_enterprise_gates?: boolean;

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

    // ✅ Enterprise tables (safe to call repeatedly)
    const db = (store as any).db;
    if (db) ensureEnterpriseTables(db);
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

    if (snapshot) {
      await verifySnapshotCheckpointOrThrow({
        store,
        decision_id: input.decision_id,
        snapshot,
      });
    }


    // ✅ Anchored snapshot verification (fail fast on tamper)
    if (snapshot) {
      const snapViolations = await verifyLoadedSnapshotOrThrow(
        store,
        input.decision_id,
        snapshot as any
      );

      if (snapViolations.length) {
        return {
          ok: false,
          decision: (snapshot as any).decision as any,
          violations: snapViolations,
        };
      }
    }

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

    // ✅ Feature 22: verify stored decision + signature integrity BEFORE accepting any new event
    if (db && !input.internal_bypass_enterprise_gates) {
      const persisted = (await store.getDecision(input.decision_id)) ?? headDecision;
      const v = verifyRiskLiabilityIntegrityOrThrow({
        store,
        decision_id: input.decision_id,
        db,
        persistedDecision: persisted,
         canonicalDecision: headDecision, // ✅ THIS WAS MISSING
      });
      if (v.length) {
        return { ok: false, decision: persisted as any, violations: v };
      }
    }
    const headDecisionMigrated = migrateProvenanceChain(headDecision);
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

    // ✅ Feature 3
    if (input.require_signer_identity_binding === true && isApprovalLike(input.event)) {
      const meta = getMeta((input.event as any)?.meta) ?? {};
      const signer_id = typeof meta.signer_id === "string" ? meta.signer_id : null;
      const signer_state_hash =
        typeof meta.signer_state_hash === "string" ? meta.signer_state_hash : null;

      const persistedHead = (await store.getDecision(input.decision_id)) ?? headDecision;
      const expected_state_hash = computeTamperStateHash(persistedHead);

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

    // ✅ Feature 15: Personal Liability Shield (PLS) enforcement
    if (input.require_liability_shield === true && isApprovalLike(input.event)) {
      const violations: PolicyViolation[] = [];

      // Require responsibility + approver to be provided by the caller
      if (!input.responsibility?.owner_id) {
        violations.push({
          code: "PLS_RESPONSIBILITY_REQUIRED",
          severity: "BLOCK",
          message: "Liability shield requires responsibility.owner_id.",
        });
      }

      if (!input.approver?.approver_id) {
        violations.push({
          code: "PLS_APPROVER_REQUIRED",
          severity: "BLOCK",
          message: "Liability shield requires approver.approver_id.",
        });
      }

      // Actor must match approver (prevents “someone else approved under my name”)
      if (
        input.approver?.approver_id &&
        (input.event as any)?.actor_id &&
        (input.event as any).actor_id !== input.approver.approver_id
      ) {
        violations.push({
          code: "PLS_APPROVER_ACTOR_MISMATCH",
          severity: "BLOCK",
          message: "Liability shield requires event.actor_id to match approver.approver_id.",
        });
      }

      // Require signer_state_hash binding to the CURRENT persisted decision state
      const meta = getMeta((input.event as any)?.meta) ?? {};
      const signer_state_hash =
        typeof meta.signer_state_hash === "string" ? meta.signer_state_hash : null;

      const persistedHead = (await store.getDecision(input.decision_id)) ?? headDecision;
      const expected_state_hash = computeTamperStateHash(persistedHead);

      if (!signer_state_hash) {
        violations.push({
          code: "PLS_SIGNER_STATE_HASH_REQUIRED",
          severity: "BLOCK",
          message: "Liability shield requires meta.signer_state_hash.",
        });
      } else if (signer_state_hash !== expected_state_hash) {
        violations.push({
          code: "PLS_SIGNER_STATE_HASH_MISMATCH",
          severity: "BLOCK",
          message: "Liability shield failed: signer_state_hash does not match current decision state.",
          details: { expected: expected_state_hash, provided: signer_state_hash } as any,
        });
      }

      if (violations.length) {
        return { ok: false, decision: headDecision, violations, consequence_preview };
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
    if (input.idempotency_key && store.findEventByIdempotencyKey) {
      const existing = await store.findEventByIdempotencyKey(
        input.decision_id,
        input.idempotency_key
      );
      if (existing) {
        const toPersist = bindDecisionId(headDecision, input.decision_id);
        await store.putDecision(toPersist);
        return {
          ok: true,
          decision: headDecision,
          warnings: headWarnings,
          consequence_preview,
        };
      }
    }


    // ✅ Feature 18: Hard RBAC gate for finalize events
    // Do this BEFORE policy engine so the behavior is deterministic and simple.
    if (!input.internal_bypass_enterprise_gates) {
      const t = input.event.type;

      // Only gate the high-impact finalize types (edit this list if needed)
      const FINALIZE_TYPES = new Set<DecisionEvent["type"]>(["APPROVE", "REJECT", "PUBLISH"] as any);

      if (FINALIZE_TYPES.has(t as any)) {
        let roles: string[] = [];
        try {
          const actorId = String((input.event as any)?.actor_id ?? "");
          if (actorId) {
            if (typeof store.listRoles === "function") {
              roles = (await store.listRoles(input.decision_id, actorId)) ?? [];
            } else if (db) {
              const rows = db
                .prepare("SELECT role FROM decision_roles WHERE decision_id=? AND actor_id=?")
                .all(input.decision_id, actorId);
              roles = rows.map((r: any) => String(r.role));
            }
          }
        } catch (e) {}

        // Define required roles per event type (customize if you want)
        const requiredByType: Record<string, string[]> = {
          APPROVE: ["approver", "admin"],
          REJECT: ["approver", "admin"],
          PUBLISH: ["publisher", "admin"],
        };

        const required = requiredByType[String(t)] ?? [];

        if (required.length && !hasAnyRole(roles, required)) {
          return {
            ok: false,
            decision: headDecision,
            violations: [
              {
                code: "RBAC_ROLE_REQUIRED",
                severity: "BLOCK",
                message: `Actor is not authorized to ${t}. Required role: ${required.join(" OR ")}.`,
                details: {
                  decision_id: input.decision_id,
                  actor_id: (input.event as any)?.actor_id ?? null,
                  actor_type: (input.event as any)?.actor_type ?? null,
                  required_roles: required,
                  actor_roles: roles,
                } as any,
              },
            ],
            consequence_preview,
          };
        }
      }
    }







    // ✅ Enterprise Policy Engine (RBAC)
    if (!input.internal_bypass_enterprise_gates) {
      const policy = createDefaultPolicyEngine();
      const now = nowIso(opts);

      let roles: string[] = [];
      try {
        if (db) {
          const rows = db
            .prepare("SELECT role FROM decision_roles WHERE decision_id=? AND actor_id=?")
            .all(input.decision_id, (input.event as any)?.actor_id);
          roles = rows.map((r: any) => String(r.role));
        }
      } catch (e) {}

      const auth = policy.authorize({
        decision_id: input.decision_id,
        decision: headDecision,
        actor: {
          actor_id: (input.event as any)?.actor_id,
          actor_type: (input.event as any)?.actor_type,
          roles,
        },
        event: input.event,
        now,
      });

      if (!auth.ok) {
        return {
          ok: false,
          decision: headDecision,
          violations: [
            {
              code: auth.code,
              severity: "BLOCK",
              message: auth.message,
              details: auth.details as any,
            },
          ],
          consequence_preview,
        };
      }
    }


    // ✅ Feature 8: enrich ATTEST_EXTERNAL event with payload+receipt
    let eventToAppend: DecisionEvent = input.event;
    // ✅ Canonical event time (deterministic replay)
    // IMPORTANT: compute ONCE and reuse, otherwise opts.now() may change between calls.
    const eventAt = nowIso(opts);

    if (input.attestor && input.event.type === "ATTEST_EXTERNAL") {
      const state_hash = computeDecisionStateHash(headDecision);

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
        attested_at: eventAt,
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
 
        // ✅ Feature 17: Trust boundary enforcement (foundation)
       if (input.enforce_trust_boundary === true) {
          // If caller provided trustContext, optionally attach a trust envelope (origin tagging)
          const hasTrustContext =
            !!(input.trustContext?.origin_zone ||
              input.trustContext?.origin_system ||
              input.trustContext?.channel ||
              input.trustContext?.tenant_id);

          const tc = input.trustContext;

          if (hasTrustContext && !(eventToAppend as any).trust) {
            (eventToAppend as any) = {
              ...(eventToAppend as any),
              trust: {
                origin: {
                  zone: tc?.origin_zone ?? undefined,
                  system: tc?.origin_system ?? undefined,
                  channel: tc?.channel ?? undefined,
                  tenant_id: tc?.tenant_id ?? undefined,
                },
                claimed_by: "store-engine",
                asserted_at: eventAt,
              },
            };
          }

          const tv = enforceTrustBoundaryV2({
            decision: headDecision,
            event: eventToAppend,
            trustContext: tc,
          } as any);

          if (tv.length) {
            return { ok: false, decision: headDecision, violations: tv, consequence_preview };
          }
        } // ✅ IMPORTANT: this brace must exist

      

      // ✅ Feature 19: Cryptographic signer binding (finalize events)
      if (input.require_signer_identity_binding === true) {
        const sb = await verifySignerBindingAsync({
          decision_id: input.decision_id,
          decision_before: headDecision, // before finalize
          event: eventToAppend,
          eventAt,
          signerDirectory: input.signerDirectory as any,
        });

        if (sb.length) {
          return { ok: false, decision: headDecision, violations: sb, consequence_preview };
        }
      } 





      // ✅ Enterprise Workflow Gate (Feature 19 unified gate)
      if (!input.internal_bypass_enterprise_gates) {
        const gated = new Set<DecisionEvent["type"]>(["APPROVE", "REJECT", "PUBLISH"] as any);

        if (gated.has(eventToAppend.type as any)) {
          const gateResult = await evaluateEventGate({
            decision_id: input.decision_id,
            decision: headDecision,
            event: eventToAppend,
            store,
            internal_bypass_enterprise_gates: !!input.internal_bypass_enterprise_gates,

            // Feature 20B: hooks (so we can later plug in real policy + state-machine cleanly)
            hooks: {
              // If you already have a state-machine helper, wire it here later.
              // Leaving it out does NOT break anything today.
              // isEventAllowedFromState: ({ state_before, event_type }) => ({ allowed: true }),

              // If you already have policy evaluation in store-engine, wire it here later.
              // evaluatePolicyForEvent: ({ decision_id, decision, event, store }) => ({ ok: true }),

              // Optional override for required roles.
              // getRequiredRolesForEvent: (t) => (["APPROVE","REJECT","PUBLISH"].includes(t) ? ["APPROVER","ADMIN"] : null),
            },
          });

          if (!gateResult.ok) {
            return {
              ok: false,
              decision: headDecision,
              violations: gateResult.violations,
              consequence_preview: gateResult.consequence_preview,
              gate_report: (gateResult as any).gate_report, // ✅ add for explainability
            } as any;
          }
        }
      }
      
      // ✅ Stamp into event so replay uses the same time later
      eventToAppend = {
        ...(eventToAppend as any),
        at: eventAt,
      } as any;

      // ✅ PREVIEW APPLY (DO NOT PERSIST EVENT YET)
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

    // ✅ Provenance is already applied inside engine.applyDecisionEvent during replayDecision.
    // Do NOT apply it again here, otherwise the persisted decision and replay head diverge.
    const withProv = rrPreview.decision;

    // optional sanity check (cheap)
    const provCheck = verifyProvenanceChain(withProv);
    if (!provCheck.ok) {
      return {
        ok: false,
        decision: withProv,
        violations: [
          {
            code: provCheck.code,
            severity: "BLOCK",
            message: provCheck.message,
            details: { index: (provCheck as any).index ?? null } as any,
          },
        ],
        consequence_preview,
      };
    }
        

    const appended = await store.appendEvent(input.decision_id, {
      at: eventAt,          // ✅ same canonical time
      event: eventToAppend, // ✅ includes .at
      idempotency_key: input.idempotency_key,
    });

    // ✅ Feature 14: Decision Provenance Graph (DAG edges)
    if (db) {
      try {
            const edges = extractDagEdgesFromEvent({ decision_id: input.decision_id, event: eventToAppend });

        if (edges.length) {
          const ins = db.prepare(`
            INSERT OR IGNORE INTO decision_edges(
              from_decision_id,
              to_decision_id,
              relation,
              via_event_seq,
              edge_hash,
              meta_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (const e of edges) {
            const meta_json =
              e.meta == null ? null : stableStringify(e.meta);

            const edge_hash = computeDecisionEdgeHash({
              from_decision_id: e.from_decision_id,
              to_decision_id: e.to_decision_id,
              relation: e.relation,
              via_event_seq: appended.seq,
              meta_json,
            });

            ins.run(
              e.from_decision_id,
              e.to_decision_id,
              e.relation,
              appended.seq,
              edge_hash,
              meta_json,
              nowIso(opts)
            );
          }
        }
      } catch (e) {
        if (process.env.DEBUG_LIABILITY) {
          console.error("❌ decision_edges insert failed", e);
        }
      }
    }

    const shouldWritePLS =
        input.require_liability_shield === true &&
        isApprovalLike(eventToAppend); // APPROVE/REJECT only (as your enforcement expects)

      const withPLS: Decision = shouldWritePLS
        ? ({
            ...(withProv as any),
            artifacts: {
              ...((withProv as any).artifacts ?? {}),
              extra: {
                ...(((withProv as any).artifacts?.extra ?? {}) as any),
                liability_shield: {
                  at: nowIso(opts),
                  decision_id: input.decision_id,
                  event_type: eventToAppend.type,
                  event_seq: appended.seq,
                  responsibility: input.responsibility ?? null,
                  approver: input.approver ?? null,
                  impact: input.impact ?? null,
                  signer_state_hash:
                    (getMeta((eventToAppend as any)?.meta) ?? {})?.signer_state_hash ?? null,
                },
              },
            },
          } as any)
        : (withProv as any);

      const toPersist = bindDecisionId(withPLS, input.decision_id);
      // ✅ persist once (canonical head for everything downstream)
      await store.putDecision(toPersist);


    // ✅ Feature 15 (Option B): persist PLS shield row (auditable)
    if (db && shouldWritePLS) {
      try {
        const owner_id = String(input.responsibility?.owner_id ?? "");
        const approver_id = String(input.approver?.approver_id ?? "");
        const signer_state_hash =
          String(((getMeta((eventToAppend as any)?.meta) ?? {}) as any)?.signer_state_hash ?? "");

        // Canonical payload_json: only what you want auditors to see (stable + deterministic)
        const payload_json = stableStringify({
          responsibility: input.responsibility ?? null,
          approver: input.approver ?? null,
          impact: input.impact ?? null,
        });

        const created_at = nowIso(opts);

        const shield_hash = sha256Hex(
          stableStringify({
            kind: "PLS_SHIELD_V1",
            decision_id: input.decision_id,
            event_seq: appended.seq,
            event_type: String(eventToAppend.type),
            owner_id,
            approver_id,
            signer_state_hash,
            payload_json,
            created_at,
          })
        );

        const existing = db.prepare(
          `SELECT shield_hash FROM pls_shields WHERE decision_id=? AND event_seq=? LIMIT 1;`
        ).get(input.decision_id, appended.seq) as any;

        if (!existing) {
          db.prepare(`
            INSERT INTO pls_shields(
              decision_id,event_seq,event_type,
              owner_id,approver_id,
              signer_state_hash,
              payload_json,
              shield_hash,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
          `).run(
            input.decision_id,
            appended.seq,
            String(eventToAppend.type),
            owner_id,
            approver_id,
            signer_state_hash,
            payload_json,
            shield_hash,
            created_at
          );
        } else {
          if (existing.shield_hash && String(existing.shield_hash) !== shield_hash) {
            return {
              ok: false,
              decision: headDecision,
              violations: [
                {
                  code: "PLS_SHIELD_TAMPERED",
                  severity: "BLOCK",
                  message: "PLS shield hash mismatch for existing decision_id+event_seq (possible tamper).",
                  details: {
                    decision_id: input.decision_id,
                    event_seq: appended.seq,
                    stored: String(existing.shield_hash),
                    computed: shield_hash,
                  } as any,
                },
              ],
              consequence_preview,
            };
          }
        }
      } catch (e) {
        // If you want strict behavior, flip this to BLOCK when require_liability_shield=true
        if (process.env.DEBUG_LIABILITY) console.error("❌ pls_shields insert failed", e);
      }
  }




    

    // ✅ Trust + Liability receipt (canonical, deterministic, obligation-aware)
    if (db) {
      try {
        const persistedHead = (await store.getDecision(input.decision_id)) ?? headDecision;

        // -----------------------------
        // 1) Tamper hashes (store integrity)
        // -----------------------------
        const beforeHash = computeTamperStateHash(stripNonStateFieldsForHash(headDecision));
        const afterHash  = computeTamperStateHash(stripNonStateFieldsForHash(toPersist));

        // -----------------------------
        // 2) Public hashes (portable, canonical identity)
        // These are what YOU can anchor / share externally.
        // -----------------------------
        // 2) Public hashes (portable, canonical identity)
        const publicBeforeHash = computePublicStateHash(stripNonStateFieldsForHash(headDecision));
        const publicAfterHash = computePublicStateHash(stripNonStateFieldsForHash(toPersist));

        const execution =
          (toPersist as any)?.artifacts?.execution ?? null;

        const obligations = Array.isArray(execution?.obligations) ? execution.obligations : [];
        const violations  = Array.isArray(execution?.violations)  ? execution.violations  : [];

        const obligations_hash = sha256Hex(
          JSON.stringify({
            obligations,
            violations,
          })
        );

        const t = computeTrust({
          decision_id: input.decision_id,
          event: eventToAppend,
          actor_id: (eventToAppend as any)?.actor_id,
          actor_type:
            ((eventToAppend as any)?.actor_type ??
              (((eventToAppend as any)?.actor_id === "system" || (eventToAppend as any)?.actor_id === "seed")
                ? "system"
                : "human")),
          now: nowIso(opts),
          prev_state_hash: beforeHash, // tamper hash is what trust uses (correct)
          next_state_hash: afterHash,  // tamper hash is what trust uses (correct)
        });

        const receipt = makeLiabilityReceipt({
          decision_id: input.decision_id,
          event_seq: appended.seq,
          event: eventToAppend,
          actor_id: (eventToAppend as any)?.actor_id,
          actor_type:
            ((eventToAppend as any)?.actor_type ??
              (((eventToAppend as any)?.actor_id === "system" || (eventToAppend as any)?.actor_id === "seed")
                ? "system"
                : "human")),
          trust_score: t.trust_score,
          trust_reason: t.trust_reason,

          // store-integrity hashes
          state_before_hash: beforeHash,
          state_after_hash: afterHash,

          obligations_hash,
          created_at: nowIso(opts),
        });

        // receipt_hash should include BOTH hash families (tamper + public) so it’s unambiguous
        const receipt_hash = computeReceiptHashV1({
          decision_id: receipt.decision_id,
          event_seq: receipt.event_seq,
          event_type: receipt.event_type,
          actor_id: receipt.actor_id,
          actor_type: receipt.actor_type,
          trust_score: receipt.trust_score,
          trust_reason: receipt.trust_reason,

          state_before_hash: receipt.state_before_hash ?? null,
          state_after_hash: receipt.state_after_hash ?? null,

          public_state_before_hash: publicBeforeHash,
          public_state_after_hash: publicAfterHash,

          obligations_hash,
          created_at: receipt.created_at,
        });


        if (process.env.DEBUG_LIABILITY) {
          const receiptViewBefore = stripNonStateFieldsForHash(headDecision);
          const receiptViewAfter  = stripNonStateFieldsForHash(toPersist);

          console.log("[LIABILITY_HASH_DEBUG]", {
            decision_id: input.decision_id,
            event_seq: appended.seq,
            event_type: eventToAppend.type,

            publicBeforeHash,
            publicAfterHash,

            tamperBeforeHash: beforeHash,
            tamperAfterHash: afterHash,

            receiptViewBeforeKeys: Object.keys(receiptViewBefore ?? {}).sort(),
            receiptViewAfterKeys: Object.keys(receiptViewAfter ?? {}).sort(),
          });
        }




        // ✅ UPDATED INSERT (adds public_state_* columns)
        db.prepare(`
          INSERT INTO liability_receipts(
            decision_id, event_seq,
            receipt_id, kind, receipt_hash,
            event_type, actor_id, actor_type,
            trust_score, trust_reason,
            state_before_hash, state_after_hash,
            public_state_before_hash, public_state_after_hash,
            obligations_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          receipt.decision_id,
          receipt.event_seq,
          receipt.receipt_id,
          "VERITASCALE_LIABILITY_RECEIPT_V1",
          receipt_hash,
          receipt.event_type,
          receipt.actor_id,
          receipt.actor_type,
          receipt.trust_score,
          receipt.trust_reason,
          receipt.state_before_hash,
          receipt.state_after_hash,
          publicBeforeHash,
          publicAfterHash,
          obligations_hash,
          receipt.created_at
        );


        // ✅ Feature 15 (Option B): persist PLS shield row (auditable) WITH receipt_hash linkage
        if (shouldWritePLS) {
          try {
            const owner_id = String(input.responsibility?.owner_id ?? "");
            const approver_id = String(input.approver?.approver_id ?? "");
            const signer_state_hash =
              String(((getMeta((eventToAppend as any)?.meta) ?? {}) as any)?.signer_state_hash ?? "");

            if (owner_id && approver_id && signer_state_hash) {
              const created_at = nowIso(opts);

              // Put receipt_hash in payload_json (your pls_shields table has payload_json but not receipt_hash column)
              const payload = {
                kind: "PLS_SHIELD_V1",
                decision_id: input.decision_id,
                event_seq: appended.seq,
                event_type: String(eventToAppend.type),

                owner_id,
                approver_id,
                signer_state_hash,

                receipt_hash, // ✅ LINK TO LIABILITY RECEIPT (this is the important part)

                responsibility: input.responsibility ?? null,
                approver: input.approver ?? null,
                impact: input.impact ?? null,

                created_at,
              };

              const payload_json = stableStringify(payload);
              const shield_hash = sha256Hex(payload_json);

              db.prepare(`
                INSERT OR IGNORE INTO pls_shields(
                  decision_id, event_seq, event_type,
                  owner_id, approver_id, signer_state_hash,
                  payload_json, shield_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                input.decision_id,
                appended.seq,
                String(eventToAppend.type),
                owner_id,
                approver_id,
                signer_state_hash,
                payload_json,
                shield_hash,
                created_at
              );
            }
          } catch (e) {
            if (process.env.DEBUG_LIABILITY) console.error("❌ pls_shields insert failed", e);
          }
        }




        // ✅ Feature 21: Risk & Liability Signature
        // (unchanged, but it continues to reference tamper hashes which is correct)
        try {
          const actor_id = (eventToAppend as any)?.actor_id ?? "unknown";
          const actor_type =
            (eventToAppend as any)?.actor_type ??
            ((actor_id === "system" || actor_id === "seed") ? "system" : "human");

          const amt = readCanonicalAmountFromDecision(toPersist);
          const payload = computeRiskLiabilitySignaturePayload({
            decision_id: input.decision_id,
            event_seq: appended.seq,
            event_type: String(eventToAppend.type),

            actor_id: String(actor_id),
            actor_type: String(actor_type),

            receipt_hash,
            state_before_hash: beforeHash,
            state_after_hash: afterHash,
            obligations_hash,

            amount_value: amt.value,
            amount_currency: amt.currency,

            responsibility: input.responsibility ?? null,
            approver: input.approver ?? null,
            impact: input.impact ?? null,

            created_at: nowIso(opts),
          });

          const payload_json = stableStringify(payload);
          const signature_hash = sha256Hex(payload_json);

          const existing = db.prepare(
            `SELECT signature_hash FROM risk_liability_signatures WHERE decision_id=? AND event_seq=?`
          ).get(input.decision_id, appended.seq);

          if (!existing) {
            db.prepare(`
              INSERT INTO risk_liability_signatures(
                decision_id, event_seq, event_type,
                actor_id, actor_type,
                receipt_hash,
                state_before_hash, state_after_hash,
                obligations_hash,
                amount_value, amount_currency,
                signature_kind, signature_hash, payload_json,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              input.decision_id,
              appended.seq,
              String(eventToAppend.type),
              String(actor_id),
              String(actor_type),
              receipt_hash,
              beforeHash,
              afterHash,
              obligations_hash,
              amt.value == null ? null : Number(amt.value),
              amt.currency ?? null,
              "RISK_LIABILITY_SIGNATURE_V1",
              signature_hash,
              payload_json,
              nowIso(opts)
            );
          } else {
            if (existing.signature_hash && String(existing.signature_hash) !== signature_hash) {
              return {
                ok: false,
                decision: headDecision,
                violations: [
                  {
                    code: "SIGNATURE_TAMPERED",
                    severity: "BLOCK",
                    message: "Risk & Liability signature mismatch for existing event_seq (possible tamper).",
                    details: {
                      decision_id: input.decision_id,
                      event_seq: appended.seq,
                      stored: String(existing.signature_hash),
                      computed: signature_hash,
                    } as any,
                  },
                ],
                consequence_preview,
              };
            }
          }

          const sigObj = {
            signature_kind: "RISK_LIABILITY_SIGNATURE_V1",
            signature_hash,
            event_seq: appended.seq,
            event_type: String(eventToAppend.type),
            actor_id: String(actor_id),
            actor_type: String(actor_type),
            receipt_hash,
            created_at: nowIso(opts),
          };

          const existingSigs = Array.isArray((toPersist as any).signatures)
            ? (toPersist as any).signatures
            : [];

          if (!existingSigs.some((s: any) => s?.signature_hash === signature_hash)) {
            (toPersist as any).signatures = [...existingSigs, sigObj];
          }

          const FINALIZE = new Set(["APPROVE", "REJECT", "PUBLISH"]);
          if (input.require_risk_liability_signature === true && FINALIZE.has(String(eventToAppend.type))) {
            const okRow = db.prepare(
              `SELECT signature_hash FROM risk_liability_signatures WHERE decision_id=? AND event_seq=?`
            ).get(input.decision_id, appended.seq);

            if (!okRow?.signature_hash) {
              return {
                ok: false,
                decision: headDecision,
                violations: [
                  {
                    code: "SIGNATURE_REQUIRED",
                    severity: "BLOCK",
                    message: "Risk & Liability signature required for finalize event, but was not created.",
                    details: { decision_id: input.decision_id, event_seq: appended.seq } as any,
                  },
                ],
                consequence_preview,
              };
            }
          }
        } catch (e) {
          if (input.require_risk_liability_signature === true) {
            return {
              ok: false,
              decision: headDecision,
              violations: [
                {
                  code: "SIGNATURE_CREATE_FAILED",
                  severity: "BLOCK",
                  message: "Risk & Liability signature creation failed.",
                  details: { error: String((e as any)?.message ?? e) } as any,
                },
              ],
              consequence_preview,
            };
          }
          if (process.env.DEBUG_LIABILITY) console.error("❌ risk_liability_signatures insert failed", e);
        }

      } catch (e) {
        if (process.env.DEBUG_LIABILITY) {
          console.error("❌ liability_receipts insert failed", e);
        }

      }
    }

    

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

    

    // optional safety check (cheap)
    const provOk = verifyProvenanceChain(toPersist);
    if (!provOk.ok) {
      return {
        ok: false,
        decision: toPersist,
        violations: [
          {
            code: "PROVENANCE_CHAIN_INVALID",
            severity: "BLOCK",
            message: provOk.message,
            details: provOk as any,
          },
        ],
        consequence_preview,
      };
    }

    

    await store.putDecision(toPersist);

    // snapshots + anchors unchanged (but ledger emission upgraded)
    if (input.snapshotStore && input.snapshotPolicy) {
      const lastSeq = appended.seq;
      const lastSnapSeq = (snapshot as any)?.up_to_seq ?? 0;

      if (shouldCreateSnapshot(input.snapshotPolicy, lastSeq, lastSnapSeq)) {
        const lastRec: any = appended ?? null;
        const checkpoint_hash =
          lastRec && (lastRec as any).hash ? String((lastRec as any).hash) : null;


          const hashes = await loadEventHashesUpToSeqBestEffort(store, input.decision_id, lastSeq);
          const root_hash = (hashes.length === lastSeq && hashes.every((h: any) => typeof h === "string" && h)) ? computeMerkleRootFromEventHashes(hashes as any) : null;
        await input.snapshotStore.putSnapshot({
          decision_id: input.decision_id,
          up_to_seq: lastSeq,
          decision: toPersist,
          created_at: nowIso(opts),
          checkpoint_hash,
          state_hash: computeDecisionStateHash(toPersist),
          provenance_tail_hash: getProvenanceTailHashFromDecision(toPersist),
          root_hash,
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
              state_hash: computeDecisionStateHash(toPersist),

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
                state_hash: (latest as any).state_hash ?? computeDecisionStateHash(rrPreview.decision),
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
  });
}

// =====================================
// ✅ Feature 16: Deterministic Rollback & Counterfactual Replay
// =====================================

export type CounterfactualEdits = {
    /**
     * Replace one or more historical events by seq.
     * - Keep `at` stable if you want strict determinism (recommended).
     */
    replace?: Array<{
      seq: number;
      event: DecisionEvent;
      keep_original_at?: boolean; // default true
    }>;

    /**
     * Drop all events AFTER this seq (history truncation).
     * If set, the counterfactual branch ends here unless you also `append`.
     */
    truncate_after_seq?: number;

    /**
     * Append extra events AFTER the (possibly truncated) history.
     * We will stamp `at` deterministically using opts.now if not provided.
     */
    append?: DecisionEvent[];
  };

export type RewindResult =
    | { ok: true; decision: Decision; up_to_seq: number; base_seq: number; warnings: PolicyViolation[] }
    | { ok: false; decision: Decision; up_to_seq: number; base_seq: number; violations: PolicyViolation[] };

export type CounterfactualResult =
    | {
        ok: true;
        decision_id: string;
        baseline: { decision: Decision; up_to_seq: number };
        counterfactual: { decision: Decision; up_to_seq: number };
        warnings: PolicyViolation[];
        used: {
          base_seq: number;
          latest_seq: number;
          replaced_seqs: number[];
          truncated_after_seq: number | null;
          appended_count: number;
        };
      }
    | {
        ok: false;
        decision_id: string;
        baseline: { decision: Decision; up_to_seq: number };
        counterfactual: { decision: Decision; up_to_seq: number };
        violations: PolicyViolation[];
        used: {
          base_seq: number;
          latest_seq: number;
          replaced_seqs: number[];
          truncated_after_seq: number | null;
          appended_count: number;
        };
      };

  // Helper: load events after base_seq, but only up to some seq (inclusive)
  async function loadEventsRange(
    store: DecisionStore,
    decision_id: string,
    after_seq: number,
    up_to_seq: number
  ): Promise<DecisionEventRecord[]> {
    const all = await loadDeltaEvents(store, decision_id, after_seq);
    return all.filter((r) => r.seq <= up_to_seq);
  }

  // Helper: load events after base_seq (full tail)
  async function loadEventsTailAll(
    store: DecisionStore,
    decision_id: string,
    after_seq: number
  ): Promise<DecisionEventRecord[]> {
    return loadDeltaEvents(store, decision_id, after_seq);
  }

// ✅ Feature 16-A: rewind to an arbitrary seq (deterministic)
export async function rewindDecisionWithStore(
    store: DecisionStore,
    input: {
      decision_id: string;
      up_to_seq: number; // target seq
      snapshotStore?: DecisionSnapshotStore;
    },
    opts: DecisionEngineOptions = {}
  ): Promise<RewindResult> {
    const decision_id = input.decision_id;
    const targetSeq = Math.max(0, Math.floor(input.up_to_seq ?? 0));

    // load root
    const rootMaybe = await store.getRootDecision(decision_id);
    if (!rootMaybe) {
      // no decision => rewind is just a clean genesis draft
      const d = createDecisionV2(
        { decision_id, meta: {}, artifacts: {}, version: 1 } as any,
        () => nowIso(opts)
      ) as any;
      return { ok: true, decision: d as any, up_to_seq: 0, base_seq: 0, warnings: [] };
    }

    // snapshot best-effort: only use it if it is <= target
    const snapshot = input.snapshotStore
      ? await input.snapshotStore.getLatestSnapshot(decision_id)
      : null;

    const canUseSnap = snapshot && Number((snapshot as any).up_to_seq ?? 0) <= targetSeq;

    const baseDecision = canUseSnap
      ? ((snapshot as any).decision as Decision)
      : canonicalDraftRootFromStored(rootMaybe);

    const baseSeq = canUseSnap ? Number((snapshot as any).up_to_seq ?? 0) : 0;

    const delta = await loadEventsRange(store, decision_id, baseSeq, targetSeq);

    const rr = replayDecision(
      baseDecision,
      delta.map((r) => r.event),
      { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
    );

    if (rr.ok === false) {
      return {
        ok: false,
        decision: rr.decision,
        up_to_seq: targetSeq,
        base_seq: baseSeq,
        violations: rr.violations,
      };
    }

    return {
      ok: true,
      decision: rr.decision,
      up_to_seq: targetSeq,
      base_seq: baseSeq,
      warnings: rr.warnings ?? [],
    };
  }

// ✅ Feature 16-B: counterfactual replay (replace / truncate / append) without persisting
export async function replayCounterfactualWithStore(
    store: DecisionStore,
    input: {
      decision_id: string;

      /**
       * What horizon to replay to.
       * - default: replay to latest (all events)
       */
      up_to_seq?: number;

      snapshotStore?: DecisionSnapshotStore;

      edits: CounterfactualEdits;
    },
    opts: DecisionEngineOptions = {}
  ): Promise<CounterfactualResult> {
    const decision_id = input.decision_id;

    // load root (required)
    const rootMaybe = await store.getRootDecision(decision_id);
    if (!rootMaybe) {
      const d = createDecisionV2(
        { decision_id, meta: {}, artifacts: {}, version: 1 } as any,
        () => nowIso(opts)
      ) as any;

      return {
        ok: false,
        decision_id,
        baseline: { decision: d as any, up_to_seq: 0 },
        counterfactual: { decision: d as any, up_to_seq: 0 },
        violations: [
          { code: "DECISION_NOT_FOUND", severity: "BLOCK", message: "Decision does not exist." },
        ],
        used: {
          base_seq: 0,
          latest_seq: 0,
          replaced_seqs: [],
          truncated_after_seq: null,
          appended_count: 0,
        },
      };
    }

    // choose base (snapshot best-effort)
    const snapshot = input.snapshotStore
      ? await input.snapshotStore.getLatestSnapshot(decision_id)
      : null;

    const baseDecision = snapshot
      ? ((snapshot as any).decision as Decision)
      : canonicalDraftRootFromStored(rootMaybe);

    const baseSeq = snapshot ? Number((snapshot as any).up_to_seq ?? 0) : 0;

    // load full tail and find latest seq
    const tailAll = await loadEventsTailAll(store, decision_id, baseSeq);
    const latestSeq = tailAll.length ? Number(tailAll[tailAll.length - 1]!.seq) : baseSeq;

    const requestedUpto =
      typeof input.up_to_seq === "number" ? Math.floor(input.up_to_seq) : latestSeq;

    const upto = Math.max(baseSeq, Math.min(requestedUpto, latestSeq));

    // baseline: replay original events up to `upto`
    const baselineEvents = tailAll.filter((r) => r.seq <= upto).map((r) => r.event);

    const rrBaseline = replayDecision(
      baseDecision,
      baselineEvents,
      { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
    );

    const baselineDecision = rrBaseline.ok ? rrBaseline.decision : rrBaseline.decision;

    // Build edited event list
    const replaceMap = new Map<number, { event: DecisionEvent; keep_original_at: boolean }>();
    for (const r of input.edits.replace ?? []) {
      if (!Number.isFinite(r.seq) || r.seq <= 0) continue;
      replaceMap.set(Math.floor(r.seq), {
        event: r.event,
        keep_original_at: r.keep_original_at !== false,
      });
    }

    const truncAfter =
      typeof input.edits.truncate_after_seq === "number"
        ? Math.floor(input.edits.truncate_after_seq)
        : null;

    const cfEvents: DecisionEvent[] = [];
    for (const rec of tailAll) {
      if (rec.seq > upto) break;

      if (truncAfter != null && rec.seq > truncAfter) break;

      const rep = replaceMap.get(rec.seq);
      if (!rep) {
        cfEvents.push(rec.event);
        continue;
      }

      // preserve original at unless caller explicitly disables
      const originalAt = (rec.event as any)?.at;
      const patched = rep.keep_original_at && originalAt
        ? ({ ...(rep.event as any), at: originalAt } as any)
        : (rep.event as any);

      cfEvents.push(patched as any);
    }

    // append extra events (stamp at deterministically if missing)
    const append = Array.isArray(input.edits.append) ? input.edits.append : [];
    const appendStamped = append.map((ev) => {
      const hasAt = typeof (ev as any)?.at === "string" && (ev as any).at.length > 0;
      return hasAt ? ev : ({ ...(ev as any), at: nowIso(opts) } as any);
    });

    cfEvents.push(...appendStamped);

    const rrCF = replayDecision(
      baseDecision,
      cfEvents,
      { ...opts, allow_locked_event_types: lockedAllowlistFromInput({}) }
    );

    const used = {
      base_seq: baseSeq,
      latest_seq: latestSeq,
      replaced_seqs: Array.from(replaceMap.keys()).sort((a, b) => a - b),
      truncated_after_seq: truncAfter,
      appended_count: appendStamped.length,
    };

    // If baseline replay failed, we still return something useful
    if (rrBaseline.ok === false) {
      return {
        ok: false,
        decision_id,
        baseline: { decision: rrBaseline.decision, up_to_seq: upto },
        counterfactual: { decision: rrBaseline.decision, up_to_seq: upto },
        violations: rrBaseline.violations,
        used,
      };
    }

    if (rrCF.ok === false) {
      return {
        ok: false,
        decision_id,
        baseline: { decision: rrBaseline.decision, up_to_seq: upto },
        counterfactual: { decision: rrCF.decision, up_to_seq: upto },
        violations: rrCF.violations,
        used,
      };
    }

    return {
      ok: true,
      decision_id,
      baseline: { decision: rrBaseline.decision, up_to_seq: upto },
      counterfactual: { decision: rrCF.decision, up_to_seq: upto },
      warnings: [...(rrBaseline.warnings ?? []), ...(rrCF.warnings ?? [])],
      used,
    };
  }


  



