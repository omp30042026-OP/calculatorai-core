// packages/decision/src/consequence-preview.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import { transitionDecisionState } from "./state-machine.js";

export type ConsequenceSeverity = "INFO" | "WARN" | "BLOCK";

export type ConsequenceWarning = {
  code:
    | "NOT_VALIDATED"
    | "NOT_SIMULATED"
    | "IRREVERSIBLE_ACTION"
    | "MISSING_ARTIFACTS"
    | "RISK_HIGH"
    | "DATA_INCOMPLETE"
    | "UNKNOWN_STATE"
    | "NO_CHANGE";
  severity: ConsequenceSeverity;
  message: string;
  details?: Record<string, unknown>;
};

export type ConsequencePreview = {
  predicted_next_state: string | null;
  delta_summary: string[];
  warnings: ConsequenceWarning[];
};

function safeString(v: unknown) {
  return typeof v === "string" ? v : null;
}

function getDecisionStateName(decision: any): string | null {
  // Your Decision likely has something like decision.state or decision.decision_state
  return safeString(decision?.state) ?? safeString(decision?.decision_state) ?? null;
}

function hasArtifacts(decision: any): boolean {
  const a = decision?.artifacts ?? decision?.decision?.artifacts;
  if (!a) return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return false;
}

function riskScore(decision: any): number | null {
  // Try common patterns without assuming structure
  const v =
    decision?.risk?.score ??
    decision?.risk_score ??
    decision?.accountability?.risk_score ??
    decision?.decision?.risk?.score;

  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function computeConsequencePreview(input: {
  decision: Decision | null;
  event: DecisionEvent;
}): ConsequencePreview {
  const warnings: ConsequenceWarning[] = [];
  const delta_summary: string[] = [];

  if (!input.decision) {
    // If decision doesn’t exist yet, we can’t simulate state transition safely.
    return {
      predicted_next_state: null,
      delta_summary: [],
      warnings: [
        {
          code: "UNKNOWN_STATE",
          severity: "INFO",
          message: "Decision does not exist yet; preview is limited (will be created if allowed).",
        },
      ],
    };
  }

  const decisionAny = input.decision as any;
  const beforeState = getDecisionStateName(decisionAny);

  // ---- Heuristic warnings (works even if your schema changes) ----
  if (input.event.type === "SIMULATE") {
    if (beforeState && beforeState !== "VALIDATED" && beforeState !== "SIMULATED") {
      warnings.push({
        code: "NOT_VALIDATED",
        severity: "WARN",
        message: "Simulation is being requested before a validated state (may be unreliable).",
        details: { beforeState },
      });
    }
  }

  if (input.event.type === "APPROVE" || input.event.type === "REJECT") {
    warnings.push({
      code: "IRREVERSIBLE_ACTION",
      severity: "WARN",
      message: `This action (${input.event.type}) is typically irreversible and may trigger downstream effects.`,
    });

    if (beforeState && beforeState !== "SIMULATED") {
        warnings.push({
            code: "NOT_SIMULATED",
            severity: "BLOCK", // ✅ make it enforceable
            message: "Approving/rejecting without a prior simulation increases the chance of bad outcomes.",
            details: { beforeState },
        });
    }

    if (!hasArtifacts(decisionAny)) {
      warnings.push({
        code: "MISSING_ARTIFACTS",
        severity: "INFO",
        message: "No supporting artifacts found; auditors may require evidence/attachments.",
      });
    }
  }

  const rs = riskScore(decisionAny);
  if (rs !== null && rs >= 0.8) {
    warnings.push({
      code: "RISK_HIGH",
      severity: "WARN",
      message: "Risk score is high; consider escalation or additional review.",
      details: { risk_score: rs },
    });
  }

  // ---- Predict next state using your actual transition function ----
  let predicted_next_state: string | null = null;

  try {
    // transitionDecisionState(decision, event) exists in your index exports.
    // If it returns a new decision object, we can diff key parts.
    const next = transitionDecisionState(input.decision as any, input.event as any) as any;

    const afterState = getDecisionStateName(next);
    predicted_next_state = afterState ?? null;

    if (beforeState && afterState && beforeState !== afterState) {
      delta_summary.push(`state: ${beforeState} → ${afterState}`);
    }

    // Tiny helpful deltas
    const beforeVer = decisionAny?.version ?? null;
    const afterVer = next?.version ?? null;
    if (typeof beforeVer === "number" && typeof afterVer === "number" && beforeVer !== afterVer) {
      delta_summary.push(`version: ${beforeVer} → ${afterVer}`);
    }

    if (delta_summary.length === 0) {
      warnings.push({
        code: "NO_CHANGE",
        severity: "INFO",
        message: "This event may not change the decision state.",
      });
    }
  } catch (e: any) {
    warnings.push({
      code: "UNKNOWN_STATE",
      severity: "INFO",
      message: "Could not predict next state (transition failed or schema mismatch).",
      details: { error: String(e?.message ?? e) },
    });
  }

  return { predicted_next_state, delta_summary, warnings };
}