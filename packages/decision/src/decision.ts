// packages/decision/src/decision.ts
import { z } from "zod";
import { ensureAccountability } from "./accountability.js";

// -------------------------
// Core enums / schemas
// -------------------------
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

// ✅ Feature 13 schemas (stored inside artifacts.execution)
const ObligationLiteSchema = z.object({
  obligation_id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
  created_at: z.string().optional(),
  due_at: z.string().nullable().optional(),
  grace_seconds: z.number().int().nonnegative().optional(),
  severity: z.enum(["INFO", "WARN", "BLOCK"]).optional(),
  status: z.enum(["OPEN", "FULFILLED", "WAIVED", "BREACHED"]).optional(),
  fulfilled_at: z.string().nullable().optional(),
  waived_at: z.string().nullable().optional(),
  waived_reason: z.string().nullable().optional(),
  proof: z
    .object({
      type: z.string().nullable().optional(),
      ref: z.string().nullable().optional(),
      payload_hash: z.string().nullable().optional(),
      meta: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const ExecutionAttestationLiteSchema = z.object({
  at: z.string(),
  actor_id: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  attestation_id: z.string().nullable().optional(),
  payload_hash: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const DecisionArtifactsSchema = z
  .object({
    explain_tree_id: z.string().optional(),
    margin_snapshot_id: z.string().optional(),
    risk_report_id: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),

    // ✅ Feature 13: execution guarantees (optional)
    execution: z
      .object({
        obligations: z.array(ObligationLiteSchema).optional(),
        attestations: z.array(ExecutionAttestationLiteSchema).optional(),
        last_evaluated_at: z.string().nullable().optional(),
      })
      .optional(),
  })
  .default({});
export type DecisionArtifacts = z.infer<typeof DecisionArtifactsSchema>;

// ✅ Feature 14: Accountability (schema)
export const DecisionAccountabilitySchema = z.object({
  owner_id: z.string().optional(),
  created_by: z.string().optional(),
  last_actor_id: z.string().optional(),
  actor_event_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type DecisionAccountabilityZ = z.infer<typeof DecisionAccountabilitySchema>;

// ✅ Feature 15: Risk Ownership + Blast Radius (schema)
export const DecisionRiskSchema = z
  .object({
    owner_id: z.string().nullable().default(null),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().default(null),

    blast_radius: z
      .array(
        z.enum([
          "FINANCIAL",
          "LEGAL",
          "SECURITY",
          "SAFETY",
          "REPUTATION",
          "PRIVACY",
          "COMPLIANCE",
          "OPERATIONAL",
          "CUSTOMER",
          "MODEL_QUALITY",
          "INFRA",
        ])
      )
      .default([]),

    impacted_systems: z.array(z.string()).default([]),

    rollback_plan_id: z.string().nullable().default(null),
    rollback_owner_id: z.string().nullable().default(null),

    notes: z.string().nullable().default(null),
    links: z.array(z.string()).default([]),
  })
  .default(() => ({
    owner_id: null,
    severity: null,
    blast_radius: [],
    impacted_systems: [],
    rollback_plan_id: null,
    rollback_owner_id: null,
    notes: null,
    links: [],
  }));
export type DecisionRisk = z.infer<typeof DecisionRiskSchema>;

// ✅ Feature 16: Decision Signatures (attestation)
export const DecisionSignatureSchema = z.object({
  at: z.string(), // ISO timestamp
  signer_id: z.string(),
  role: z.string().nullable().default(null),
  method: z.enum(["HMAC", "ED25519", "RSA", "EIP191", "CUSTOM"]).default("CUSTOM"),
  payload_hash: z.string(),
  signature: z.string(),
  key_id: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DecisionSignature = z.infer<typeof DecisionSignatureSchema>;

export const DecisionSchema = z.object({
  decision_id: z.string(),
  version: z.number().int().min(1).default(1),
  parent_decision_id: z.string().optional(),

  state: DecisionStateSchema,

  created_at: z.string(),
  updated_at: z.string(),

  meta: z.record(z.string(), z.unknown()).default({}),
  artifacts: DecisionArtifactsSchema,

  accountability: DecisionAccountabilitySchema.optional(),
  risk: DecisionRiskSchema,
  signatures: z.array(DecisionSignatureSchema).default([]),

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
    execution?: any;
  };

  risk?: Partial<DecisionRisk>;
  signatures?: DecisionSignature[];
};

export function createDecisionV2(
  input: CreateDecisionInput,
  now = () => new Date().toISOString()
): Decision {
  const ts = now();

  const ownerFromMeta =
    input.meta && typeof (input.meta as any).owner_id === "string"
      ? String((input.meta as any).owner_id)
      : null;

  const d: Decision = {
    decision_id: input.decision_id,
    version: input.version ?? 1,
    parent_decision_id: input.parent_decision_id,

    state: "DRAFT",

    created_at: ts,
    updated_at: ts,

    meta: input.meta ?? {},
    artifacts: input.artifacts ?? {},

    risk: {
      owner_id: ownerFromMeta,
      ...(input.risk ?? {}),
    } as any,

    signatures: input.signatures ?? [],
    history: [],
  };

  const parsed = DecisionSchema.parse(d);
  return ensureAccountability(parsed) as Decision;
}


