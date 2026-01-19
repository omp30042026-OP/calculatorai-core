// packages/decision/src/obligations.ts
import { z } from "zod";

// -----------------------------
// Feature 13 — Execution Guarantees
// obligations + execution attestations + SLA breach detection
// -----------------------------

export type ObligationStatus = "OPEN" | "FULFILLED" | "WAIVED" | "BREACHED";
export type ObligationSeverity = "INFO" | "WARN" | "BLOCK";

export const ObligationSchema = z.object({
  obligation_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().default(null),

  // who owns execution
  owner_id: z.string().nullable().default(null),

  // when created
  created_at: z.string(),

  // SLA
  due_at: z.string().nullable().default(null), // ISO
  grace_seconds: z.number().int().nonnegative().default(0),

  // enforcement strength
  severity: z.enum(["INFO", "WARN", "BLOCK"]).default("WARN"),

  // status tracking
  status: z.enum(["OPEN", "FULFILLED", "WAIVED", "BREACHED"]).default("OPEN"),
  fulfilled_at: z.string().nullable().default(null),
  waived_at: z.string().nullable().default(null),
  waived_reason: z.string().nullable().default(null),

  // proof / evidence links
  proof: z
    .object({
      type: z.string().nullable().default(null), // e.g. "JIRA", "GITHUB_PR", "RUNBOOK", "CUSTOM"
      ref: z.string().nullable().default(null), // id/url/etc
      payload_hash: z.string().nullable().default(null),
      meta: z.record(z.string(), z.unknown()).nullable().default(null),
    })
    .default(() => ({
      type: null,
      ref: null,
      payload_hash: null,
      meta: null,
    })),

  // tags (optional)
  tags: z.record(z.string(), z.string()).default({}),
});

export type Obligation = z.infer<typeof ObligationSchema>;

export const ExecutionAttestationSchema = z.object({
  at: z.string(),
  actor_id: z.string().nullable().default(null),
  provider: z.string().nullable().default(null), // e.g. "internal", "pagerduty", "github", "custom"
  attestation_id: z.string().nullable().default(null),
  payload_hash: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type ExecutionAttestation = z.infer<typeof ExecutionAttestationSchema>;

// ✅ minimal violation shape (engine treats as any[] but checks severity/resolved_at)
export const ExecutionViolationSchema = z.object({
  violation_id: z.string().min(1),
  code: z.string().min(1),
  severity: z.enum(["INFO", "WARN", "BLOCK"]).default("WARN"),
  message: z.string().min(1),
  at: z.string(),
  obligation_id: z.string().nullable().default(null),
  resolved_at: z.string().nullable().default(null),
  resolved_by: z.string().nullable().default(null),
  resolution_note: z.string().nullable().default(null),
});

export type ExecutionViolation = z.infer<typeof ExecutionViolationSchema>;

export const ExecutionArtifactsSchema = z
  .object({
    obligations: z.array(ObligationSchema).default([]),
    attestations: z.array(ExecutionAttestationSchema).default([]),

    // ✅ engine expects this to exist
    violations: z.array(ExecutionViolationSchema).default([]),

    // derived status (optional, cached for convenience)
    last_evaluated_at: z.string().nullable().default(null),
  })
  .default(() => ({
    obligations: [],
    attestations: [],
    violations: [],
    last_evaluated_at: null,
  }));

export type ExecutionArtifacts = z.infer<typeof ExecutionArtifactsSchema>;

function pickExecSource(input: any): any {
  // input may be:
  // - Decision: { artifacts: { extra: { execution }, execution } }
  // - artifacts object: { extra: { execution }, execution }
  // - execution object already: { obligations, attestations, ... }

  // Decision?
  const artifacts =
    input?.artifacts && typeof input.artifacts === "object" ? input.artifacts : input;

  const extra =
    artifacts?.extra && typeof artifacts.extra === "object" ? artifacts.extra : {};

  // Prefer canonical location used by your code/tests:
  // artifacts.extra.execution
  if (extra?.execution && typeof extra.execution === "object") return extra.execution;

  // Back-compat:
  if (artifacts?.execution && typeof artifacts.execution === "object")
    return artifacts.execution;

  // Maybe caller passed the execution object directly
  if (input && typeof input === "object" && ("obligations" in input || "attestations" in input)) {
    return input;
  }

  return {};
}

/**
 * ✅ IMPORTANT:
 * Your engine calls ensureExecutionArtifacts(decision)
 * so this function MUST accept a Decision and return a Decision.
 *
 * We also keep back-compat: if someone passes artifacts or exec,
 * we still behave reasonably.
 */
export function ensureExecutionArtifacts(input: any): any {
  const execSrc = pickExecSource(input);
  const parsed = ExecutionArtifactsSchema.parse(execSrc);

  // If input looks like a Decision (has .artifacts), return Decision with merged artifacts
  if (input?.artifacts && typeof input.artifacts === "object") {
    const a: any = input.artifacts ?? {};
    const extra: any = a.extra ?? {};

    return {
      ...input,
      artifacts: {
        ...a,
        execution: parsed, // compat
        extra: {
          ...extra,
          execution: parsed, // canonical
        },
      },
    };
  }

  // If input looks like artifacts (has execution/extra), return artifacts updated
  if (input && typeof input === "object" && ("execution" in input || "extra" in input)) {
    const a: any = input ?? {};
    const extra: any = a.extra ?? {};
    return {
      ...a,
      execution: parsed,
      extra: { ...extra, execution: parsed },
    };
  }

  // Fallback: return the parsed exec bag
  return parsed;
}

export function upsertObligation(exec: ExecutionArtifacts, obligation: Obligation): ExecutionArtifacts {
  const next = [...(exec.obligations ?? [])];
  const idx = next.findIndex((o) => o.obligation_id === obligation.obligation_id);
  if (idx >= 0) next[idx] = obligation;
  else next.push(obligation);
  return { ...exec, obligations: next };
}

export function getObligation(exec: ExecutionArtifacts, obligation_id: string): Obligation | null {
  const o = (exec.obligations ?? []).find((x) => x.obligation_id === obligation_id);
  return o ?? null;
}

export function markFulfilled(
  o: Obligation,
  atIso: string,
  proof?: Partial<Obligation["proof"]> | null
): Obligation {
  return {
    ...o,
    status: "FULFILLED",
    fulfilled_at: atIso,
    proof: { ...(o.proof ?? ({} as any)), ...(proof ?? {}) } as any,
  };
}

export function markWaived(o: Obligation, atIso: string, reason?: string | null): Obligation {
  return {
    ...o,
    status: "WAIVED",
    waived_at: atIso,
    waived_reason: reason ?? null,
  };
}

function parseIsoMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function evaluateSlaStatus(o: Obligation, nowIso: string): ObligationStatus {
  // If it's ever been fulfilled/waived, that should win over SLA breach.
  // This also fixes cases where status was BREACHED but later fulfilled_at got set.
  if (o.fulfilled_at) return "FULFILLED";
  if (o.waived_at) return "WAIVED";
  if (o.status === "FULFILLED" || o.status === "WAIVED") return o.status;
  if (!o.due_at) return "OPEN";

  const dueMs = parseIsoMs(o.due_at);
  const nowMs = parseIsoMs(nowIso);
  if (dueMs === null || nowMs === null) return "OPEN";

  const deadlineMs = dueMs + (o.grace_seconds ?? 0) * 1000;
  return nowMs > deadlineMs ? "BREACHED" : "OPEN";
}

function breachToViolation(o: Obligation, nowIso: string): ExecutionViolation {
  const vid = `viol_${o.obligation_id}_${nowIso}`;
  return {
    violation_id: vid,
    code: "OBLIGATION_BREACHED",
    severity: (o.severity ?? "WARN") as any,
    message: `Obligation breached: ${o.title}`,
    at: nowIso,
    obligation_id: o.obligation_id,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
  };
}

export function evaluateExecution(
  exec: ExecutionArtifacts,
  nowIso: string
): {
  exec: ExecutionArtifacts;
  breached: Obligation[];
  violations: ExecutionViolation[];
  new_violations: ExecutionViolation[];
} {
  const nextObs: Obligation[] = [];
  const breached: Obligation[] = [];

  // Build a quick lookup for terminal obligations after evaluation
  const terminalById = new Map<string, "FULFILLED" | "WAIVED">();

  for (const o of exec.obligations ?? []) {
    // ✅ Terminal always wins
    const isTerminal =
      o.fulfilled_at != null ||
      o.waived_at != null ||
      o.status === "FULFILLED" ||
      o.status === "WAIVED";

    if (isTerminal) {
      nextObs.push(o);
      if (typeof o.obligation_id === "string" && o.obligation_id.length) {
        terminalById.set(
          o.obligation_id,
          o.status === "WAIVED" || o.waived_at ? "WAIVED" : "FULFILLED"
        );
      }
      continue;
    }

    const status = evaluateSlaStatus(o, nowIso);
    const next = status === "BREACHED" ? { ...o, status: "BREACHED" as const } : { ...o, status };

    nextObs.push(next);
    if (next.status === "BREACHED") breached.push(next);
  }

  const existing = Array.isArray(exec.violations) ? exec.violations : [];

  // ✅ Auto-resolve any open breach violations for obligations that are now terminal
  const normalizedExisting: ExecutionViolation[] = existing.map((v: any) => {
    if (
      v?.code === "OBLIGATION_BREACHED" &&
      v?.resolved_at == null &&
      typeof v?.obligation_id === "string" &&
      terminalById.has(v.obligation_id)
    ) {
      return {
        ...v,
        resolved_at: nowIso,
        resolved_by: "system",
        resolution_note: `Auto-resolved: obligation ${terminalById.get(v.obligation_id)}`,
      };
    }
    return v;
  });

  // Dedupe open breaches by obligation_id
  const openByObl = new Set(
    normalizedExisting
      .filter((v: any) => v?.code === "OBLIGATION_BREACHED" && !v?.resolved_at && v?.obligation_id)
      .map((v: any) => String(v.obligation_id))
  );

  const new_violations: ExecutionViolation[] = [];
  for (const b of breached) {
    // only create new violation for non-terminal obligations
    if (!terminalById.has(b.obligation_id) && !openByObl.has(b.obligation_id)) {
      new_violations.push(breachToViolation(b, nowIso));
    }
  }

  const nextExec: ExecutionArtifacts = {
    ...exec,
    obligations: nextObs,
    violations: [...normalizedExisting, ...new_violations],
    last_evaluated_at: nowIso,
  };

  return { exec: nextExec, breached, violations: nextExec.violations, new_violations };
}

// -----------------------------
// 13.2 helpers used by engine.ts
// (array-level mutations so engine stays thin)
// -----------------------------

export function upsertObligationArray(obligations: any[], obl: any): any[] {
  const id = obl?.obligation_id;
  if (typeof id !== "string" || !id.length) return obligations;

  const idx = obligations.findIndex((o) => o?.obligation_id === id);
  if (idx === -1) return [...obligations, obl];

  const next = obligations.slice();
  next[idx] = { ...(next[idx] ?? {}), ...obl };
  return next;
}

export function markObligationFulfilled(
  obligations: any[],
  obligation_id: string,
  atIso: string,
  proof?: any | null
): any[] {
  return obligations.map((o) =>
    o?.obligation_id === obligation_id
      ? {
          ...o,
          status: "FULFILLED",
          fulfilled_at: atIso,
          proof: proof ? { ...(o?.proof ?? {}), ...proof } : (o?.proof ?? undefined),
        }
      : o
  );
}

export function markObligationWaived(
  obligations: any[],
  obligation_id: string,
  atIso: string,
  reason?: string | null
): any[] {
  return obligations.map((o) =>
    o?.obligation_id === obligation_id
      ? {
          ...o,
          status: "WAIVED",
          waived_at: atIso,
          waived_reason: typeof reason === "string" ? reason : null,
        }
      : o
  );
}

export function resolveObligationViolations(
  violations: any[],
  obligation_id: string,
  nowIso: string,
  actor_id: string | null | undefined,
  note?: string | null
): any[] {
  return (violations ?? []).map((v) => {
    if (v?.obligation_id !== obligation_id) return v;
    if (v?.resolved_at) return v;
    return {
      ...v,
      resolved_at: nowIso,
      resolved_by: actor_id ?? "system",
      resolution_note: note ?? "Obligation fulfilled",
    };
  });
}

