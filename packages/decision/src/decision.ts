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

export const DecisionArtifactsSchema = z
  .object({
    explain_tree_id: z.string().optional(),
    margin_snapshot_id: z.string().optional(),
    risk_report_id: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
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

  // optional role/human meaning
  role: z.string().nullable().default(null),

  // how it was signed
  method: z.enum(["HMAC", "ED25519", "RSA", "EIP191", "CUSTOM"]).default("CUSTOM"),

  // what the signature covers (hash of canonical payload)
  payload_hash: z.string(),

  // proof material
  signature: z.string(),

  // key identifier or reference (optional)
  key_id: z.string().nullable().default(null),

  // extra metadata (optional)
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

  // ✅ Feature 14
  accountability: DecisionAccountabilitySchema.optional(),

  // ✅ Feature 15
  risk: DecisionRiskSchema,

  // ✅ Feature 16
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
  };

  // ✅ Feature 15 (optional seed)
  risk?: Partial<DecisionRisk>;

  // ✅ Feature 16 (optional seed)
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

    // ✅ Feature 15: seed risk; schema fills the rest via defaults
    risk: {
      owner_id: ownerFromMeta,
      ...(input.risk ?? {}),
    } as any,

    // ✅ Feature 16: seed signatures (usually empty on create)
    signatures: input.signatures ?? [],

    history: [],
  };

  const parsed = DecisionSchema.parse(d);

  // ✅ Feature 14: ensure default accountability object exists
  return ensureAccountability(parsed) as Decision;
}

