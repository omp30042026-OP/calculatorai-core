// packages/decision/src/engine.ts
import { transitionDecisionState, isNoStateChangeEvent } from "./state-machine";
import type { Decision } from "./decision";
import { createDecisionV2 } from "./decision";
import type { DecisionEvent } from "./events";
import type { DecisionPolicy, PolicyViolation } from "./policy";
import { defaultPolicies } from "./policy";
import { applyAccountability } from "./accountability";

import {
  ObligationSchema,
  evaluateExecution,
  upsertObligationArray,
  markObligationFulfilled,
  markObligationWaived,
  resolveObligationViolations,
} from "./obligations";
import { applyProvenanceTransition, verifyProvenanceChain, migrateProvenanceChain } from "./provenance";

import { setDecisionRisk } from "./risk";
/**
 * IMPORTANT:
 * Your current events.ts does NOT include these legacy event types,
 * but your example scripts may still emit them.
 *
 * So we support them at runtime via (event as any).type, WITHOUT breaking TS.
 */
type LegacyEventType = "SET_OBLIGATIONS" | "AUTO_VIOLATION" | "RESOLVE_VIOLATION";
type AnyEventType = DecisionEvent["type"] | LegacyEventType;

type ExecBag = {
  obligations: any[];
  attestations: any[];
  violations: any[];
  last_evaluated_at: string | null;
};

function normalizeExecBag(input: any): ExecBag {
  const bag = input && typeof input === "object" ? input : {};
  return {
    obligations: Array.isArray(bag.obligations) ? bag.obligations : [],
    attestations: Array.isArray(bag.attestations) ? bag.attestations : [],
    violations: Array.isArray(bag.violations) ? bag.violations : [],
    last_evaluated_at: typeof bag.last_evaluated_at === "string" ? bag.last_evaluated_at : null,
  };
}

function getExecBag(decision: Decision): ExecBag {
  const a: any = decision.artifacts ?? {};
  const extra = a.extra ?? {};

  // Prefer canonical location first: artifacts.execution
  // Fallback to legacy/compat: artifacts.extra.execution
  return normalizeExecBag(a.execution ?? extra.execution);
}

function cloneExecBag(bag: ExecBag): ExecBag {
  return {
    obligations: Array.isArray(bag.obligations) ? bag.obligations.map((x) => (x && typeof x === "object" ? { ...x } : x)) : [],
    attestations: Array.isArray(bag.attestations) ? bag.attestations.map((x) => (x && typeof x === "object" ? { ...x } : x)) : [],
    violations: Array.isArray(bag.violations) ? bag.violations.map((x) => (x && typeof x === "object" ? { ...x } : x)) : [],
    last_evaluated_at: typeof bag.last_evaluated_at === "string" ? bag.last_evaluated_at : null,
  };
}

function setExecBag(decision: Decision, bag: ExecBag): Decision {
  const a: any = decision.artifacts ?? {};
  const extra = a.extra ?? {};

  // ✅ prevent shared-reference / circular issues
  const bagCompat = JSON.parse(JSON.stringify(bag));
  const bagCanon = JSON.parse(JSON.stringify(bag));

  return {
    ...decision,
    artifacts: {
      ...a,
      execution: bagCompat,                 // compat copy
      extra: { ...extra, execution: bagCanon }, // canonical copy
    },
  } as any;
}

function hasOpenBlockViolation(violations: any[]): boolean {
  return violations.some((v) => v?.severity === "BLOCK" && !v?.resolved_at);
}

/**
 * ✅ NEW:
 * If the payload contains remediation identifiers anywhere,
 * we must allow it even while blocked, otherwise you can never unblock.
 */
function hasDeepKey(obj: any, keys: string[], depth = 6): boolean {
  if (depth <= 0 || obj == null) return false;
  if (typeof obj !== "object") return false;

  if (Array.isArray(obj)) {
    for (const x of obj) if (hasDeepKey(x, keys, depth - 1)) return true;
    return false;
  }

  for (const k of Object.keys(obj)) {
    if (keys.includes(k)) return true;
    if (hasDeepKey((obj as any)[k], keys, depth - 1)) return true;
  }
  return false;
}

function isRemediationPayload(eventObj: any): boolean {
  // obligation remediation (fulfill/waive etc)
  if (hasDeepKey(eventObj, ["obligation_id", "obligationId"])) return true;
  // resolving violations
  if (hasDeepKey(eventObj, ["violation_id", "violationId"])) return true;
  return false;
}


function isoToSecond(iso: string): string {
  const d = new Date(iso);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}




function extractObligationId(e: any, exec?: { obligations?: any[] }): string {
  const src = e && typeof e === "object" ? e : {};

  // common shapes
  const o =
    (src.obligation && typeof src.obligation === "object" ? src.obligation : null) ||
    (src.data && typeof src.data === "object" ? src.data : null) ||
    src;

  const id =
    (typeof o.obligation_id === "string" && o.obligation_id) ||
    (typeof o.obligationId === "string" && o.obligationId) ||
    (typeof o.id === "string" && o.id) ||
    (typeof src.obligation_id === "string" && src.obligation_id) ||
    (typeof src.obligationId === "string" && src.obligationId) ||
    (typeof src.id === "string" && src.id) ||
    "";

  if (id) return id;

  // ✅ FINAL FALLBACK: if exactly one obligation exists, use it
  const obs = Array.isArray(exec?.obligations) ? exec!.obligations : [];
  if (obs.length === 1 && typeof obs[0]?.obligation_id === "string") {
    return obs[0].obligation_id;
  }

  return "";
}

export type DecisionEngineOptions = {
  policies?: DecisionPolicy[];
  now?: () => string;
  allow_locked_event_types?: Array<DecisionEvent["type"]>;
};

export type ApplyEventResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

function isLockedState(s: Decision["state"]): boolean {
  return s === "APPROVED" || s === "REJECTED";
}

function getLockedAllowlist(opts: DecisionEngineOptions): Set<AnyEventType> {
  const base = (opts.allow_locked_event_types ?? [
    "ATTACH_ARTIFACTS",
    "SIGN",
    "ATTEST_EXTERNAL",
    "ENTER_DISPUTE",
    "EXIT_DISPUTE",
    "ADD_OBLIGATION",
    "FULFILL_OBLIGATION",
    "WAIVE_OBLIGATION",
    "ATTEST_EXECUTION",

    // ✅ Feature 15
    "SET_RISK",
    "ADD_BLAST_RADIUS",
    "ADD_IMPACTED_SYSTEM",
    "SET_ROLLBACK_PLAN",
  ]) as AnyEventType[];

  return new Set<AnyEventType>([
    ...base,
    "SET_OBLIGATIONS",
    "AUTO_VIOLATION",
    "RESOLVE_VIOLATION",
  ]);
}

function disputeEnabled(decision: Decision): boolean {
  return Boolean((decision.artifacts as any)?.dispute?.enabled);
}

function allowedInDispute(eventType: AnyEventType): boolean {
  return (
    eventType === "ENTER_DISPUTE" ||
    eventType === "EXIT_DISPUTE" ||
    eventType === "ATTACH_ARTIFACTS" ||
    eventType === "SIGN" ||
    eventType === "ATTEST_EXTERNAL" ||
    eventType === "ADD_OBLIGATION" ||
    eventType === "FULFILL_OBLIGATION" ||
    eventType === "WAIVE_OBLIGATION" ||
    eventType === "ATTEST_EXECUTION" ||
    eventType === "SET_OBLIGATIONS" ||
    eventType === "AUTO_VIOLATION" ||
    eventType === "RESOLVE_VIOLATION" ||
    eventType === "SET_RISK" ||
    eventType === "ADD_BLAST_RADIUS" ||
    eventType === "ADD_IMPACTED_SYSTEM" ||
    eventType === "SET_ROLLBACK_PLAN" 
  );
}

function applyDisputeArtifacts(decision: Decision, event: DecisionEvent, nowIso: string): Decision {
  if (event.type === "ENTER_DISPUTE") {
    return {
      ...decision,
      artifacts: {
        ...(decision.artifacts ?? {}),
        dispute: {
          enabled: true,
          entered_at: nowIso,
          entered_by: event.actor_id ?? "system",
          reason: "reason" in event ? ((event as any).reason ?? null) : null,
        },
        extra: {
          ...((decision.artifacts as any)?.extra ?? {}),
        },
      } as any,
    };
  }

  if (event.type === "EXIT_DISPUTE") {
    const prev = (decision.artifacts as any)?.dispute ?? {};
    return {
      ...decision,
      artifacts: {
        ...(decision.artifacts ?? {}),
        dispute: {
          ...prev,
          enabled: false,
          exited_at: nowIso,
          exited_by: event.actor_id ?? "system",
          exit_reason: "reason" in event ? ((event as any).reason ?? null) : null,
        },
        extra: {
          ...((decision.artifacts as any)?.extra ?? {}),
        },
      } as any,
    };
  }

  return decision;
}

function pickEventTypeRaw(e: any): any {
  // search a few common wrappers (up to 6 levels deep)
  let cur: any = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    if (cur.type != null) return cur.type;
    if (cur.eventType != null) return cur.eventType;
    if (cur.event_type != null) return cur.event_type;

    // common nesting keys
    cur = cur.event ?? cur.data ?? cur.payload ?? cur.body ?? cur.message ?? null;
  }

  // last-chance shallow fallbacks
  return (
    e?.type ??
    e?.event?.type ??
    e?.event?.event?.type ??
    e?.data?.type ??
    e?.payload?.type ??
    e?.eventType ??
    e?.event_type ??
    null
  );
}

function unwrapEvent(e: any): any {
  // unwrap common wrappers consistently
  return e?.event ?? e?.data ?? e?.payload ?? e?.body ?? e?.message ?? e;
}

function normalizeEventType(raw: any): AnyEventType {
  return String(raw ?? "")
    .trim()
    // ✅ turn camelCase/PascalCase into snake_case first
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1_$2") // handles "ATTESTExecution" style
    // ✅ normalize separators
    .replace(/[\s-]+/g, "_")
    .toUpperCase()
    // ✅ remove weird chars
    .replace(/[^A-Z0-9_]/g, "") as AnyEventType;
}

export function applyDecisionEvent(
  decision: Decision,
  event: DecisionEvent,
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const policies = opts.policies ?? defaultPolicies();

  // Support both shapes:
  // 1) event = { type: "..." }
  // 2) event = { event: { type: "..." } }  (wrapper accidentally passed through)
  // 3) event = { event: { event: { type: "..." } } } (double-wrapped)
  const e0: any = unwrapEvent(event as any);
  const eventTypeRaw0 = pickEventTypeRaw(event as any);

  // extra-deep fallback for odd wrappers
  const inner =
    (event as any)?.event ??
    (event as any)?.data ??
    (event as any)?.payload ??
    (event as any)?.body ??
    (event as any)?.message ??
    null;

  const eventTypeRaw1 = pickEventTypeRaw(inner);
  const t = normalizeEventType(eventTypeRaw1 ?? eventTypeRaw0);

  if (!t) {
    return {
      ok: false,
      decision,
      violations: [
        {
          code: "INVALID_EVENT_TYPE",
          severity: "BLOCK",
          message: `Missing/unknown event type (raw=${String(eventTypeRaw1 ?? eventTypeRaw0)}).`,
        },
      ],
    };
  }

  // dispute mode enforcement
  if (disputeEnabled(decision) && !allowedInDispute(t)) {
    return {
      ok: false,
      decision,
      violations: [
        {
          code: "DISPUTE_MODE_BLOCK",
          severity: "BLOCK",
          message: `Decision is in dispute mode; event ${t} is not allowed.`,
        },
      ],
    };
  }

  // Feature 13: hard block if open BLOCK execution violation exists
  const exec0 = getExecBag(decision);

  if (hasOpenBlockViolation(exec0.violations)) {
    const allowedSet = new Set<AnyEventType>([
      // diagnostics
      "VALIDATE",
      "SIMULATE",
      "EXPLAIN",

      // safe ops
      "ATTACH_ARTIFACTS",
      "SIGN",
      "ATTEST_EXTERNAL",
      "ATTEST_EXECUTION",
      "ENTER_DISPUTE",
      "EXIT_DISPUTE",

      // remediation
      "ADD_OBLIGATION",
      "FULFILL_OBLIGATION",
      "WAIVE_OBLIGATION",

      // legacy/admin
      "SET_OBLIGATIONS",
      "AUTO_VIOLATION",
      "RESOLVE_VIOLATION",
    ]);

    const allowed =
      allowedSet.has(t) ||
      isRemediationPayload(e0) ||                 // ✅ use unwrapped event
      isRemediationPayload(event as any) ||       // ✅ also check wrapper
      /FULFILL|WAIVE|ADD_OBLIGATION|RESOLVE_VIOLATION/i.test(JSON.stringify(event));

    // ✅ THIS is the missing piece
    //console.log("[EXEC_BLOCK_GUARD]", { t, allowed, sample: (event as any)?.type, e0_type: (e0 as any)?.type });
    if (!allowed) {
      return {
        ok: false,
        decision,
        violations: [
          {
            code: "EXECUTION_BLOCKED",
            severity: "BLOCK",
            message:
              "Decision is blocked due to an unresolved execution violation (SLA/obligation breach).",
          },
        ],
      };
    }
  }

  const noStateChange = isNoStateChangeEvent(t as any);

  const FEATURE13_NO_STATE: AnyEventType[] = [
    "ADD_OBLIGATION",
    "FULFILL_OBLIGATION",
    "WAIVE_OBLIGATION",
    "ATTEST_EXECUTION",
    "SET_OBLIGATIONS",
    "AUTO_VIOLATION",
    "RESOLVE_VIOLATION",

    // ✅ Feature 15 (no state change)
    "SET_RISK",
    "ADD_BLAST_RADIUS",
    "ADD_IMPACTED_SYSTEM",
    "SET_ROLLBACK_PLAN",
  ];

  const isArtifactOnly = t === "ATTACH_ARTIFACTS" || noStateChange || FEATURE13_NO_STATE.includes(t);

  const nextState = isArtifactOnly
    ? decision.state
    : transitionDecisionState(decision.state as any, t as any);

  const IDEMPOTENT_SAME_STATE = new Set<DecisionEvent["type"]>(["VALIDATE", "SIMULATE", "EXPLAIN"]);

  if (
    !isArtifactOnly &&
    nextState === decision.state &&
    t !== "REJECT" &&
    !(typeof event.type === "string" && IDEMPOTENT_SAME_STATE.has(event.type))
  ) {
    return {
      ok: false,
      decision,
      violations: [
        {
          code: "INVALID_TRANSITION",
          severity: "BLOCK",
          message: `Event ${t} is not valid from state ${decision.state}.`,
        },
      ],
    };
  }

  // policies
  const warnings: PolicyViolation[] = [];
  const violations: PolicyViolation[] = [];

  for (const p of policies) {
    const r = p({ decision, event });
    if (!r.ok) {
      for (const v of r.violations) {
        if (v.severity === "WARN") warnings.push(v);
        else violations.push(v);
      }
    }
  }

  if (violations.length > 0) return { ok: false, decision, violations };

  const nextBase: Decision = {
    ...decision,
    state: t === "REJECT" ? "REJECTED" : nextState,
    updated_at: now(),
    artifacts:
      t === "ATTACH_ARTIFACTS"
        ? {
            ...(decision.artifacts ?? {}),
            ...(event as any).artifacts,
            extra: {
              ...((decision.artifacts as any)?.extra ?? {}),
              ...(((event as any).artifacts as any)?.extra ?? {}),
            },
          }
        : (decision.artifacts ?? {}),
    history: [
      ...(decision.history ?? []),
      {
        at: now(),
        type: t,
        actor_id: (event as any).actor_id ?? null,
        reason: "reason" in (event as any) ? ((event as any).reason ?? null) : null,
        meta: (event as any).meta ?? null,
      },
    ],
  };

  const withDispute = applyDisputeArtifacts(nextBase, event, now());

  // ✅ Feature 15: Risk Ownership + Blast Radius mutations (no state change)
  let withRisk: Decision = withDispute;

  if (t === "SET_RISK") {
    const e: any = e0;
    const patch =
      (e && typeof e === "object" ? (e.risk ?? e.data?.risk ?? e.payload?.risk ?? e) : {}) ?? {};
    // Allow passing: { risk: {...} } OR directly { owner_id, severity, ... }
    const riskPatch = patch.risk && typeof patch.risk === "object" ? patch.risk : patch;
    withRisk = setDecisionRisk(withRisk, riskPatch);
  }

  if (t === "ADD_BLAST_RADIUS") {
    const e: any = e0;
    const add = e?.blast_radius ?? e?.blastRadius ?? e?.data?.blast_radius ?? e?.data?.blastRadius ?? [];
    const incoming = Array.isArray(add) ? add : [add];
    const cur = (withRisk.risk?.blast_radius ?? []) as any[];
    const merged = Array.from(new Set([...cur, ...incoming].map((x) => String(x))));
    withRisk = setDecisionRisk(withRisk, { blast_radius: merged as any });
  }

  if (t === "ADD_IMPACTED_SYSTEM") {
    const e: any = e0;
    const add = e?.system ?? e?.impacted_system ?? e?.impactedSystem ?? e?.data?.system ?? e?.data?.impacted_system ?? [];
    const incoming = Array.isArray(add) ? add : [add];
    const cur = (withRisk.risk?.impacted_systems ?? []) as any[];
    const merged = Array.from(new Set([...cur, ...incoming].map((x) => String(x))));
    withRisk = setDecisionRisk(withRisk, { impacted_systems: merged as any });
  }

  if (t === "SET_ROLLBACK_PLAN") {
    const e: any = e0;
    const rollback_plan_id = e?.rollback_plan_id ?? e?.rollbackPlanId ?? e?.data?.rollback_plan_id ?? null;
    const rollback_owner_id = e?.rollback_owner_id ?? e?.rollbackOwnerId ?? e?.data?.rollback_owner_id ?? null;
    withRisk = setDecisionRisk(withRisk, {
      rollback_plan_id: typeof rollback_plan_id === "string" ? rollback_plan_id : null,
      rollback_owner_id: typeof rollback_owner_id === "string" ? rollback_owner_id : null,
    });
  }

  // ---- Feature 13 execution mutations ----
  let withExec: Decision = withRisk;

  // normalize execution bag from the decision itself
  let exec = getExecBag(withExec);

  // Ensure canonical location exists (artifacts.execution + artifacts.extra.execution)
  withExec = setExecBag(withExec, exec);

  // Legacy
  if (t === "SET_OBLIGATIONS") {
    exec = normalizeExecBag({
      ...exec,
      obligations: Array.isArray((event as any).obligations) ? (event as any).obligations : [],
    });
    withExec = setExecBag(withExec, exec);
  }

  if (t === "AUTO_VIOLATION") {
    const v = (event as any).violation ?? null;
    if (v) {
      exec = normalizeExecBag({ ...exec, violations: [...exec.violations, v] });
      withExec = setExecBag(withExec, exec);
    }
  }

  if (t === "RESOLVE_VIOLATION") {
    const vid = (event as any).violation_id ?? null;
    const note = (event as any).note ?? null;
    if (typeof vid === "string" && vid.length) {
      exec = normalizeExecBag({
        ...exec,
        violations: exec.violations.map((vv) =>
          vv?.violation_id === vid || vv?.id === vid
            ? {
                ...vv,
                resolved_at: isoToSecond(now()),
                resolved_by: (event as any).actor_id ?? "system",
                resolution_note: typeof note === "string" ? note : null,
              }
            : vv
        ),
      });
      withExec = setExecBag(withExec, exec);
    }
  }

  if (t === "ADD_OBLIGATION") {
    const e: any = e0;

    const src = e && typeof e === "object" ? e : {};
    const o = src.obligation && typeof src.obligation === "object" ? src.obligation : src;

    const obligation_id =
      typeof o.obligation_id === "string" && o.obligation_id.length
        ? o.obligation_id
        : typeof o.obligationId === "string" && o.obligationId.length
          ? o.obligationId
          : typeof o.id === "string" && o.id.length
            ? o.id
            : "";

    const title = typeof o.title === "string" ? o.title : "";

    if (obligation_id && title) {
      // preserve created_at across replays
      const existing = exec.obligations.find((x) => x?.obligation_id === obligation_id) ?? null;
      const created_at =
        existing && typeof existing.created_at === "string" && existing.created_at.length
          ? existing.created_at
          : now();

      const obligationCandidate = {
        obligation_id,
        title,
        description: typeof o.description === "string" ? o.description : null,
        owner_id: typeof o.owner_id === "string" ? o.owner_id : null,
        created_at,
        due_at: typeof o.due_at === "string" ? o.due_at : null,
        grace_seconds: typeof o.grace_seconds === "number" ? o.grace_seconds : 0,
        severity: (typeof o.severity === "string" ? o.severity : "WARN") as any,
        status:
          existing && typeof existing.status === "string" && existing.status.length
            ? existing.status
            : "OPEN",
        fulfilled_at:
          existing && typeof existing.fulfilled_at === "string" ? existing.fulfilled_at : null,
        waived_at: existing && typeof existing.waived_at === "string" ? existing.waived_at : null,
        waived_reason:
          existing && typeof existing.waived_reason === "string" ? existing.waived_reason : null,
        proof: existing?.proof ?? undefined,
        tags: (o.tags && typeof o.tags === "object" ? o.tags : (existing?.tags ?? {})) as any,
      };

      let obl: any = obligationCandidate;
      try {
        obl = ObligationSchema.parse(obligationCandidate);
      } catch {
        // keep best-effort
      }

      exec = normalizeExecBag({
        ...exec,
        obligations: upsertObligationArray(exec.obligations, obl),
      });

      withExec = setExecBag(withExec, exec);
    }
  }

  if (t === "FULFILL_OBLIGATION") {
    const e: any = e0;

    const obligation_id = extractObligationId(e, exec);

    const proofIn =
      e?.proof ??
      e?.data?.proof ??
      (e?.obligation && typeof e.obligation === "object" ? e.obligation.proof : null);

    if (obligation_id) {
      const atIso = now();

      exec = normalizeExecBag({
        ...exec,
        obligations: markObligationFulfilled(exec.obligations, obligation_id, atIso, proofIn),
      });

      exec = normalizeExecBag({
        ...exec,
        violations: resolveObligationViolations(
          exec.violations,
          obligation_id,
          atIso,
          e?.actor_id ?? null,
          "Obligation fulfilled"
        ),
      });

      withExec = setExecBag(withExec, exec);
    }
  }


  if (t === "WAIVE_OBLIGATION") {
    const e: any = e0;

    const obligation_id = extractObligationId(e, exec);
    const reason = e?.reason ?? null;

    if (obligation_id) {
      const atIso = now();

      exec = normalizeExecBag({
        ...exec,
        obligations: markObligationWaived(exec.obligations, obligation_id, atIso, reason),
      });

      exec = normalizeExecBag({
        ...exec,
        violations: resolveObligationViolations(
          exec.violations,
          obligation_id,
          atIso,
          e?.actor_id ?? null,
          "Obligation waived"
        ),
      });

      withExec = setExecBag(withExec, exec);
    }
  }

  // ATTEST_EXECUTION
  if (t === "ATTEST_EXECUTION") {
    const e: any = e0;

    const atIso = now();

    const obligation_id =
      (typeof e?.obligation_id === "string" && e.obligation_id) ||
      (typeof e?.obligationId === "string" && e.obligationId) ||
      (typeof e?.obligation?.obligation_id === "string" && e.obligation.obligation_id) ||
      (typeof e?.obligation?.id === "string" && e.obligation.id) ||
      "";

    const att = {
      at: atIso,
      actor_id: e?.actor_id ?? null,
      provider: e?.provider ?? null,
      attestation_id: e?.attestation_id ?? null,
      payload_hash: e?.payload_hash ?? null,
      url: e?.url ?? null,
      meta: e?.meta ?? null,

      // ✅ link (optional)
      obligation_id: obligation_id || null,
    };

    exec = normalizeExecBag({
      ...exec,
      attestations: [...exec.attestations, att],
    });

    // ✅ If attestation references an obligation, treat as proof + auto-fulfill
    if (obligation_id) {
      const proof = {
        type: e?.provider ?? "ATTEST_EXECUTION",
        ref: e?.url ?? e?.attestation_id ?? null,
        payload_hash: e?.payload_hash ?? null,
        meta: e?.meta ?? null,
      };

      exec = normalizeExecBag({
        ...exec,
        obligations: markObligationFulfilled(exec.obligations, obligation_id, atIso, proof),
      });

      exec = normalizeExecBag({
        ...exec,
        violations: resolveObligationViolations(
          exec.violations,
          obligation_id,
          atIso,
          e?.actor_id ?? null,
          "Obligation fulfilled via execution attestation"
        ),
      });
    }

    withExec = setExecBag(withExec, exec);
  }
  

  // -----------------------------------------
  // SAFEGUARD: prevent evaluateExecution from wiping/rewriting obligations
  // -----------------------------------------
  const beforeEval = exec;

  try {
    const nowIso = now();

    // Keep a protected snapshot (NEVER passed into evaluator)
    const preEvalSnapshot = JSON.parse(JSON.stringify(exec));

    // Evaluator gets its OWN copy (safe to mutate)
    const evalInput = JSON.parse(JSON.stringify(exec));
    const out = (evaluateExecution as any)(evalInput as any, nowIso);

    // evaluator may return exec, else use the mutated evalInput
    const nextExec = out?.exec ?? evalInput;
    const breached = Array.isArray(out?.breached) ? out.breached : [];

    // Merge obligations:
    // - default to evaluator view (so OPEN can become BREACHED)
    // - but NEVER lose terminal states we already set (FULFILLED/WAIVED) + timestamps/proof
    const mergeObligations = (terminalPrefer: any[], evaluator: any[]) => {
      const byId = new Map<string, any>();

      for (const o of Array.isArray(evaluator) ? evaluator : []) {
        const id = o?.obligation_id;
        if (typeof id === "string" && id.length) byId.set(id, o);
      }

      for (const o of Array.isArray(terminalPrefer) ? terminalPrefer : []) {
        const id = o?.obligation_id;
        if (typeof id !== "string" || !id.length) continue;

        const prev = byId.get(id);
        const preferStatus = o?.status;

        // Only force overwrite if we already made it terminal
        if (preferStatus === "FULFILLED" || preferStatus === "WAIVED") {
          byId.set(id, prev ? { ...prev, ...o } : o);
        }
      }

      return Array.from(byId.values());
    };

    const mergedObligations = mergeObligations(
      preEvalSnapshot.obligations,
      (nextExec as any)?.obligations
    );

    // Violations: start from evaluator, but do NOT lose resolved_at that we already set
    const evalViolations = Array.isArray((nextExec as any)?.violations)
      ? (nextExec as any).violations
      : [];
    const preViolations = Array.isArray(preEvalSnapshot.violations)
      ? preEvalSnapshot.violations
      : [];

    const byViolationId = new Map<string, any>();
    for (const v of evalViolations) {
      const id = v?.violation_id ?? v?.id;
      if (typeof id === "string" && id.length) byViolationId.set(id, v);
    }
    for (const v of preViolations) {
      const id = v?.violation_id ?? v?.id;
      if (typeof id !== "string" || !id.length) continue;

      const prev = byViolationId.get(id);
      // if we already resolved it, keep that resolution
      if (v?.resolved_at && (!prev || !prev.resolved_at)) {
        byViolationId.set(id, prev ? { ...prev, ...v } : v);
      }
    }

    const prevViolations = Array.from(byViolationId.values());

    // Track existing OPEN breach violations (so we don't duplicate)
    const openBreachByObl = new Set<string>();
    for (const v of prevViolations) {
      if (
        v?.code === "OBLIGATION_BREACHED" &&
        v?.resolved_at == null &&
        typeof v?.obligation_id === "string" &&
        v.obligation_id.length
      ) {
        openBreachByObl.add(v.obligation_id);
      }
    }

    // Create NEW breach violations only for BLOCK obligations not already open-breached
    const newBreachViolations = breached
      .filter((o: any) => (o?.severity ?? "WARN") === "BLOCK")
      .filter((o: any) => typeof o?.obligation_id === "string" && o.obligation_id.length)
      .filter((o: any) => !openBreachByObl.has(o.obligation_id))
      .map((o: any) => ({
        violation_id: `viol_${o.obligation_id}_${nowIso}`,
        code: "OBLIGATION_BREACHED",
        severity: "BLOCK",
        message: `Obligation breached: ${o?.title ?? o?.obligation_id}`,
        at: nowIso,
        obligation_id: o.obligation_id,
        resolved_at: null,
        resolved_by: null,
        resolution_note: null,
      }));

    exec = normalizeExecBag({
      ...nextExec,
      obligations: mergedObligations,
      violations: [...prevViolations, ...newBreachViolations],
      last_evaluated_at: isoToSecond((nextExec as any)?.last_evaluated_at ?? nowIso),
    });

    withExec = setExecBag(withExec, exec);
  } catch {
    exec = normalizeExecBag({
      ...beforeEval,
      last_evaluated_at: isoToSecond(now()),
    });
    withExec = setExecBag(withExec, exec);
  }

  // accountability (IMPORTANT: preserve execution bag if accountability mutates artifacts)
  const next0 = applyAccountability(withExec, event);

  // Re-attach execution bag from withExec (prevents it getting wiped)
  const next = setExecBag(next0 as any, getExecBag(withExec));

  // ✅ Feature 14: provenance (cryptographic lineage)
  const nextWithProv = applyProvenanceTransition({
    before: decision,
    after: next as any,
    event,
    event_type: t,
    nowIso: now(),
  });

  // ✅ Feature 15.1: verify chain on every mutation
  //(nextWithProv as any).artifacts.provenance.nodes[0].event_type = "HACKED";
  //const migrated = migrateProvenanceChain(nextWithProv as any);

  const vr = verifyProvenanceChain(nextWithProv as any);
  if (!vr.ok) {
    return {
      ok: false,
      decision: nextWithProv as any,
      violations: [
        {
          code: "PROVENANCE_TAMPERED",
          severity: "BLOCK",
          message: `${vr.code}: ${vr.message}${typeof vr.index === "number" ? ` (index=${vr.index})` : ""}`,
        },
      ],
    };
  }

  return { ok: true, decision: nextWithProv as any, warnings };
}

export function replayDecision(
  start: Decision,
  events: DecisionEvent[],
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  let cur: Decision = start;
  let allWarnings: PolicyViolation[] = [];

  for (const e of events) {
    const r = applyDecisionEvent(cur, e, opts);
    if (!r.ok) return r;
    cur = r.decision;
    allWarnings = [...allWarnings, ...r.warnings];
  }

  return { ok: true, decision: cur, warnings: allWarnings };
}

export type ForkDecisionInput = {
  decision_id: string;
  meta?: Record<string, unknown>;
  artifacts?: Decision["artifacts"];
};

export function forkDecision(
  parent: Decision,
  input: ForkDecisionInput,
  opts: DecisionEngineOptions = {}
): Decision {
  if (parent.state === "REJECTED") {
    throw new Error(`Cannot fork a REJECTED decision (${parent.decision_id}).`);
  }

  const now = opts.now ?? (() => new Date().toISOString());

  const mergedMeta: Record<string, unknown> = {
    ...(parent.meta ?? {}),
    ...(input.meta ?? {}),
  };

  const mergedArtifacts: Decision["artifacts"] = {
    ...(parent.artifacts ?? {}),
    ...(input.artifacts ?? {}),
    extra: {
      ...(((parent.artifacts as any)?.extra ?? {}) as Record<string, unknown>),
      ...((((input.artifacts as any)?.extra ?? {}) as Record<string, unknown>)),
    },
  };

  return createDecisionV2(
    {
      decision_id: input.decision_id,
      parent_decision_id: parent.decision_id,
      version: (parent.version ?? 1) + 1,
      meta: mergedMeta,
      artifacts: mergedArtifacts as any,
    },
    now
  );
}

export { createDecisionV2 };


