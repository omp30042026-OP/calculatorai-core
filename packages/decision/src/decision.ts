import { z } from "zod";

export const DecisionStateSchema = z.enum([
  "DRAFT",
  "VALIDATED",
  "SIMULATED",
  "EXPLAINED",
  "APPROVED",
  "REJECTED",
]);
export type DecisionState = z.infer<typeof DecisionStateSchema>;

export const DecisionHistoryEntrySchema = z.object({
  at: z.string(), // ISO timestamp
  type: z.string(),
  actor_id: z.string().nullable(),
  reason: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});
export type DecisionHistoryEntry = z.infer<typeof DecisionHistoryEntrySchema>;

export const DecisionArtifactsSchema = z
  .object({
    explain_tree_id: z.string().optional(),
    margin_snapshot_id: z.string().optional(),
    risk_report_id: z.string().optional(),
    // keep it flexible for future
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .default({});

export type DecisionArtifacts = z.infer<typeof DecisionArtifactsSchema>;

export const DecisionSchema = z.object({
  decision_id: z.string(),
  version: z.number().int().min(1).default(1),
  parent_decision_id: z.string().optional(),

  state: DecisionStateSchema,

  created_at: z.string(),
  updated_at: z.string(),

  // free-form, but required fields can be enforced by policies
  meta: z.record(z.string(), z.unknown()).default({}),

  artifacts: DecisionArtifactsSchema,

  history: z.array(DecisionHistoryEntrySchema).default([]),
});

export type Decision = z.infer<typeof DecisionSchema>;

export type CreateDecisionInput = {
  decision_id: string;
  meta?: Record<string, unknown>;
  parent_decision_id?: string;
  version?: number;
  artifacts?: {
    explain_tree_id?: string;
    margin_snapshot_id?: string;
    risk_report_id?: string;
    extra?: Record<string, unknown>;
  };
};

export function createDecisionV2(
  input: CreateDecisionInput,
  now = () => new Date().toISOString()
): Decision {
  const ts = now();

  const d: Decision = {
    decision_id: input.decision_id,
    version: input.version ?? 1,
    parent_decision_id: input.parent_decision_id,

    state: "DRAFT",

    created_at: ts,
    updated_at: ts,

    meta: input.meta ?? {},
    artifacts: input.artifacts ?? {},

    history: [],
  };

  return DecisionSchema.parse(d);
}

