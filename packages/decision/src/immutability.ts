// packages/decision/src/immutability.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { PolicyViolation } from "./policy.js";

export type ImmutabilityPolicy = {
  enabled?: boolean; // default true
  locked_states?: string[]; // default ["APPROVED", "REJECTED"]
  lock_after_seconds?: number; // default 0 (immediate)
  allow_event_types?: string[]; // default ["ADD_NOTE","ATTACH_ARTIFACTS"]
};

function safeIsoMs(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * We use decision.history to find when it entered a locked state.
 * For APPROVED/REJECTED we look for last APPROVE/REJECT event timestamp.
 */
function findLockStartIso(decision: any, lockedState: string): string | null {
  const h: any[] = Array.isArray(decision?.history) ? decision.history : [];

  if (lockedState === "APPROVED") {
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]?.type === "APPROVE" && typeof h[i]?.at === "string") return h[i].at;
    }
  }

  if (lockedState === "REJECTED") {
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]?.type === "REJECT" && typeof h[i]?.at === "string") return h[i].at;
    }
  }

  // fallback: updated_at if present
  return typeof decision?.updated_at === "string" ? decision.updated_at : null;
}

export function enforceImmutabilityWindow(input: {
  policy?: ImmutabilityPolicy;
  decision: Decision;
  event: DecisionEvent;
  nowIso: string;
}): { ok: true } | { ok: false; violations: PolicyViolation[] } {
  const policy = input.policy;
  const enabled = policy?.enabled ?? true;
  if (!enabled) return { ok: true };

  const lockedStates = policy?.locked_states ?? ["APPROVED", "REJECTED"];
  const allowTypes = policy?.allow_event_types ?? [
    // evidence / audit-only (existing)
    "ADD_NOTE",
    "ATTACH_ARTIFACTS",

    // diagnostics (safe)
    "VALIDATE",
    "SIMULATE",
    "EXPLAIN",

    // remediation (safe, lets you fix breaches even after APPROVE)
    "ADD_OBLIGATION",
    "FULFILL_OBLIGATION",
    "WAIVE_OBLIGATION",

    // attestations (safe)
    "ATTEST_EXECUTION",
    "ATTEST_EXTERNAL",

    // signatures (safe)
    "SIGN",

    // if you use dispute mode
    "ENTER_DISPUTE",
    "EXIT_DISPUTE",

    // legacy (optional)
    "SET_OBLIGATIONS",
    "AUTO_VIOLATION",
    "RESOLVE_VIOLATION",
  ];
  const graceSeconds = policy?.lock_after_seconds ?? 0;

  const state = (input.decision as any)?.state;
  if (!state || !lockedStates.includes(String(state))) return { ok: true };

  // allowlist (evidence / audit-only)
  if (allowTypes.includes(input.event.type)) return { ok: true };

  const lockStartIso = findLockStartIso(input.decision as any, String(state));
  const lockStartMs = safeIsoMs(lockStartIso);
  const nowMs = safeIsoMs(input.nowIso);

  // if we cannot compute time, be conservative and lock
  if (lockStartMs === null || nowMs === null) {
    return {
      ok: false,
      violations: [
        {
          code: "IMMUTABLE_WINDOW_LOCKED",
          severity: "BLOCK",
          message: `Decision is immutable in state ${String(state)} (time parsing failed).`,
        },
      ],
    };
  }

  const lockAfterMs = Math.max(0, graceSeconds) * 1000;
  const locked = nowMs >= lockStartMs + lockAfterMs;

  if (!locked) return { ok: true };

  return {
    ok: false,
    violations: [
      {
        code: "IMMUTABLE_WINDOW_LOCKED",
        severity: "BLOCK",
        message: `Decision is immutable in state ${String(state)}; event ${input.event.type} is not allowed.`,
      },
    ],
  };
}


