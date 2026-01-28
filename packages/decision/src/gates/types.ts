export type GateViolation = {
  code: string;
  severity: "INFO" | "WARN" | "BLOCK";
  message: string;
  details?: any;
};

export type GateReport = {
  ok: boolean;

  decision_id: string;
  event_type: string;

  // component results
  state_ok: boolean;
  rbac_ok: boolean;
  workflow_ok: boolean;
  policy_ok: boolean;

  // explainability
  violations: GateViolation[];

  // helpful debugging / UI
  workflow?: {
    workflow_id: string;
    status: any; // WorkflowStatus
  };

  // optional: “what would happen if applied”
  consequence_preview?: any;

  // “what we evaluated against”
  context?: {
    pending_event_type?: string | null;
    actor_id?: string;
    actor_type?: string;
    bypass?: boolean;
  };
};
