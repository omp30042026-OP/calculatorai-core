// packages/decision/src/gates/evaluate-event-gate.ts
import { computeWorkflowStatus, defaultWorkflowTemplates } from "../workflow-engine";

export type GateViolation = {
  code: string;
  severity: "BLOCK" | "WARN" | "INFO";
  message: string;
  details?: any;
};

export type GateResult =
  | { ok: true; violations: []; consequence_preview?: any }
  | { ok: false; violations: GateViolation[]; consequence_preview?: any };

export async function evaluateEventGate(params: {
  decision_id: string;
  decision: any | null;
  event: any;
  store: any;
  internal_bypass_enterprise_gates: boolean;
}): Promise<GateResult> {
  const { decision, event, internal_bypass_enterprise_gates } = params;

  // If bypass is enabled, allow everything (enterprise bypass).
  if (internal_bypass_enterprise_gates) {
    return { ok: true, violations: [] };
  }

  // If decision doesn't exist yet, let store-engine/state-machine handle it.
  // (We keep this gate “non-destructive”: it won't invent transitions here.)
  if (!decision) {
    return { ok: true, violations: [] };
  }

  // -----------------------------
  // Feature 19 (start): Workflow gate
  // -----------------------------
  // Use default workflow template for now (wf_basic_approval).
  // You can expand later to select per decision.meta.workflow_id etc.
  const templates = defaultWorkflowTemplates();
  const template = templates[0]!; // ✅ guaranteed non-undefined

  const workflowStatus = computeWorkflowStatus({
    template,
    decision,
    pending_event_type: event?.type ?? null, // ✅ counts the event being attempted
  });

  // Only enforce workflow on finalize-like events.
  // (This matches what your system is already doing: it blocked APPROVE before.)
  const enforceOn = new Set(["APPROVE", "REJECT"]);
  if (enforceOn.has(String(event?.type)) && !workflowStatus.is_complete) {
    return {
      ok: false,
      violations: [
        {
          code: "WORKFLOW_INCOMPLETE",
          severity: "BLOCK",
          message: `Workflow not complete for ${String(event?.type)}`,
          details: { workflow_id: template.workflow_id, status: workflowStatus },
        },
      ],
      consequence_preview: {
        predicted_next_state: decision?.state ?? null,
        delta_summary: [],
        warnings: [],
      },
    };
  }

  return { ok: true, violations: [] };
}

