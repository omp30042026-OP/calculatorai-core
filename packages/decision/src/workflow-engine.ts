// packages/decision/src/workflow-engine.ts
export type WorkflowStep = {
  step_id: string;
  type: "REQUIRE_EVENT" | "REQUIRE_FIELD" | "REQUIRE_ATTESTATION";
  value: any; // event_type | field_name | attestation_type
  required: boolean;
};

export type WorkflowTemplate = {
  workflow_id: string;
  name: string;
  steps: WorkflowStep[];
};

export type WorkflowStatus = {
  workflow_id: string;
  satisfied_steps: Record<string, boolean>;
  is_complete: boolean;
};

export function defaultWorkflowTemplates(): WorkflowTemplate[] {
  return [
    {
      workflow_id: "wf_basic_approval",
      name: "Basic Approval",
      steps: [
        { step_id: "s1_require_amount", type: "REQUIRE_FIELD", value: "amount", required: true },
        { step_id: "s2_require_validate", type: "REQUIRE_EVENT", value: "VALIDATE", required: true },
        // NOTE: This is fine as long as workflow evaluation includes the "pending" event.
        { step_id: "s3_require_approve_or_reject", type: "REQUIRE_EVENT", value: ["APPROVE", "REJECT"], required: true },
      ],
    },
  ];
}

export function computeWorkflowStatus(params: {
  template: WorkflowTemplate;
  decision: any; // expects decision.history + fields in decision/artifacts/meta as per your system
  pending_event_type?: string | null; // ✅ NEW: allow gate checks for the event being attempted
}): WorkflowStatus {
  const { template, decision, pending_event_type } = params;

  const historyTypes: string[] = (decision?.history ?? []).map((h: any) => h.type);
  const decisionObj = decision ?? {};

  // ✅ treat the currently-attempted event as “present” for gating
  const historyPlus = pending_event_type
    ? [...historyTypes, pending_event_type]
    : historyTypes;

  const satisfied: Record<string, boolean> = {};

  for (const step of template.steps) {
    let ok = false;

    if (step.type === "REQUIRE_EVENT") {
      if (Array.isArray(step.value)) ok = step.value.some((t) => historyPlus.includes(t));
      else ok = historyPlus.includes(step.value);
    }

    if (step.type === "REQUIRE_FIELD") {
      const key = String(step.value);

      const direct = decisionObj?.[key];
      const fields = decisionObj?.fields?.[key];
      const artifacts = decisionObj?.artifacts?.[key];            // ✅ ADD THIS
      const artifactsFields = decisionObj?.artifacts?.fields?.[key]; // ✅ optional but safe
      const extra = decisionObj?.artifacts?.extra?.[key];

      const anyVal = fields ?? artifactsFields ?? artifacts ?? direct ?? extra;

      if (anyVal == null) {
        ok = false;
      } else if (typeof anyVal === "object") {
        // for shapes like { value: 2500, currency: "USD" }
        ok = (anyVal as any)?.value != null || Object.keys(anyVal as any).length > 0;
      } else {
        ok = true;
      }
    }

    if (step.type === "REQUIRE_ATTESTATION") {
      const attestations: any[] =
        decisionObj?.attestations ??
        decisionObj?.artifacts?.attestations ??
        [];
      ok = attestations.some((a) => a?.type === step.value);
    }

    satisfied[step.step_id] = ok;
  }

  const is_complete = template.steps.every(
    (s) => !s.required || satisfied[s.step_id] === true
  );

  return { workflow_id: template.workflow_id, satisfied_steps: satisfied, is_complete };
}