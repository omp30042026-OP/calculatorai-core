// packages/decision/src/events.ts
import { z } from "zod";
import type { DecisionEventType } from "./state-machine.js";

// -----------------------------
// Actor schema (V14-ready)
// -----------------------------
const ActorIdSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .transform((v) => (v && v.length ? v : undefined));

const ActorTypeSchema = z.enum(["human", "service", "system"]).optional();

// -----------------------------
// Base event
// -----------------------------
const BaseEventSchema = z.object({
  type: z.custom<DecisionEventType>(),
  actor_id: ActorIdSchema,
  actor_type: ActorTypeSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
});

// -----------------------------
// Core lifecycle events
// -----------------------------
export const ValidateEventSchema = BaseEventSchema.extend({
  type: z.literal("VALIDATE"),
});

export const SimulateEventSchema = BaseEventSchema.extend({
  type: z.literal("SIMULATE"),
  simulation_snapshot_id: z.string().optional(),
});

export const ExplainEventSchema = BaseEventSchema.extend({
  type: z.literal("EXPLAIN"),
  explain_tree_id: z.string().optional(),
});

export const ApproveEventSchema = BaseEventSchema.extend({
  type: z.literal("APPROVE"),
});

export const RejectEventSchema = BaseEventSchema.extend({
  type: z.literal("REJECT"),
  reason: z.string().optional(),
});

// -----------------------------
// Attach artifacts (evidence)
// -----------------------------
export const AttachArtifactsEventSchema = BaseEventSchema.extend({
  type: z.literal("ATTACH_ARTIFACTS"),
  artifacts: z
    .object({
      explain_tree_id: z.string().optional(),
      margin_snapshot_id: z.string().optional(),
      risk_report_id: z.string().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

// -----------------------------
// Feature 16: SIGN
// -----------------------------
export const SignEventSchema = BaseEventSchema.extend({
  type: z.literal("SIGN"),
  signer_id: z.string().optional(),
  role: z.string().optional(),
  method: z.enum(["HMAC", "ED25519", "RSA", "EIP191", "CUSTOM"]).optional(),
  payload_hash: z.string(),
  signature: z.string(),
  key_id: z.string().optional(),
});

// -----------------------------
// Feature 6: INGEST_RECORDS
// -----------------------------
const IngestRecordSchema = z.object({
  source_system: z.string(),
  source_record_id: z.string(),
  occurred_at: z.string(), // ISO
  entity_type: z.string(),
  payload: z.unknown(),
});

export const IngestRecordsEventSchema = BaseEventSchema.extend({
  type: z.literal("INGEST_RECORDS"),
  records: z.array(IngestRecordSchema).min(1),
});

// -----------------------------
// Feature 7: LINK_DECISIONS
// -----------------------------
const DecisionLinkRelationSchema = z.enum([
  "DEPENDS_ON",
  "BLOCKS",
  "DUPLICATES",
  "DERIVES_FROM",
  "RELATED_TO",
]);

const DecisionLinkSchema = z.object({
  to_decision_id: z.string(),
  relation: DecisionLinkRelationSchema,
  note: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const LinkDecisionsEventSchema = BaseEventSchema.extend({
  type: z.literal("LINK_DECISIONS"),
  links: z.array(DecisionLinkSchema).min(1),
});

// -----------------------------
// Feature 8: ATTEST_EXTERNAL
// -----------------------------
export const AttestExternalEventSchema = BaseEventSchema.extend({
  type: z.literal("ATTEST_EXTERNAL"),
  provider: z.string().optional(),
  receipt_id: z.string().optional(),
  url: z.string().optional(),
  proof: z.string().optional(),
  payload_hash: z.string().optional(),
});

// -----------------------------
// Feature 9: DISPUTE MODE
// -----------------------------
export const EnterDisputeEventSchema = BaseEventSchema.extend({
  type: z.literal("ENTER_DISPUTE"),
  reason: z.string().optional(),
});

export const ExitDisputeEventSchema = BaseEventSchema.extend({
  type: z.literal("EXIT_DISPUTE"),
  reason: z.string().optional(),
});

// -----------------------------
// ✅ Feature 13: Execution Guarantees
// -----------------------------
export const AddObligationEventSchema = BaseEventSchema.extend({
  type: z.literal("ADD_OBLIGATION"),
  obligation_id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  owner_id: z.string().optional(),
  due_at: z.string().optional(), // ISO
  grace_seconds: z.number().int().nonnegative().optional(),
  severity: z.enum(["INFO", "WARN", "BLOCK"]).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const FulfillObligationEventSchema = BaseEventSchema.extend({
  type: z.literal("FULFILL_OBLIGATION"),
  obligation_id: z.string(),
  proof: z
    .object({
      type: z.string().optional(),
      ref: z.string().optional(),
      payload_hash: z.string().optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const WaiveObligationEventSchema = BaseEventSchema.extend({
  type: z.literal("WAIVE_OBLIGATION"),
  obligation_id: z.string(),
  reason: z.string().optional(),
});

export const AttestExecutionEventSchema = BaseEventSchema.extend({
  type: z.literal("ATTEST_EXECUTION"),
  provider: z.string().optional(),
  attestation_id: z.string().optional(),
  payload_hash: z.string().optional(),
  url: z.string().optional(),
});

// -----------------------------
// ✅ Feature 15: Risk Ownership + Blast Radius (events)
// -----------------------------
export const SetRiskEventSchema = BaseEventSchema.extend({
  type: z.literal("SET_RISK"),
  // patch object (engine can merge it)
  risk: z
    .object({
      owner_id: z.string().nullable().optional(),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(),
      blast_radius: z.array(z.string()).optional(),
      impacted_systems: z.array(z.string()).optional(),
      rollback_plan_id: z.string().nullable().optional(),
      rollback_owner_id: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      links: z.array(z.string()).optional(),
    })
    .partial()
    .optional(),

  // also allow direct fields (in case caller sends them at top-level)
  owner_id: z.string().nullable().optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(),
  blast_radius: z.array(z.string()).optional(),
  impacted_systems: z.array(z.string()).optional(),
  rollback_plan_id: z.string().nullable().optional(),
  rollback_owner_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  links: z.array(z.string()).optional(),
});

export const AddBlastRadiusEventSchema = BaseEventSchema.extend({
  type: z.literal("ADD_BLAST_RADIUS"),
  blast_radius: z.union([z.string(), z.array(z.string())]),
});

export const AddImpactedSystemEventSchema = BaseEventSchema.extend({
  type: z.literal("ADD_IMPACTED_SYSTEM"),
  system: z.union([z.string(), z.array(z.string())]).optional(),
  impacted_system: z.union([z.string(), z.array(z.string())]).optional(),
});

export const SetRollbackPlanEventSchema = BaseEventSchema.extend({
  type: z.literal("SET_ROLLBACK_PLAN"),
  rollback_plan_id: z.string().nullable().optional(),
  rollback_owner_id: z.string().nullable().optional(),
});


// -----------------------------
// ✅ Feature 15: Personal Liability Shield (PLS) events
// -----------------------------
export const AssignResponsibilityEventSchema = BaseEventSchema.extend({
  type: z.literal("ASSIGN_RESPONSIBILITY"),
  responsibility: z.object({
    owner_id: z.string(),
    owner_role: z.string().optional(),
    org_id: z.string().optional(),
    scope: z.string().optional(), // optional “what I own”
    valid_from: z.string().optional(), // ISO
    valid_to: z.string().optional(),   // ISO
    notes: z.string().optional(),
  }),
});

export const AcceptRiskEventSchema = BaseEventSchema.extend({
  type: z.literal("ACCEPT_RISK"),
  acceptance: z.object({
    accepted_by: z.string(),
    accepted_role: z.string().optional(),
    org_id: z.string().optional(),
    rationale: z.string().optional(),
    ticket: z.string().optional(),
    expires_at: z.string().optional(), // ISO
    // binds acceptance to a specific state
    signer_state_hash: z.string().optional(),
  }),
});





// -----------------------------
// Union
// -----------------------------
export const DecisionEventSchema = z.union([
  ValidateEventSchema,
  SimulateEventSchema,
  ExplainEventSchema,
  ApproveEventSchema,
  RejectEventSchema,
  AttachArtifactsEventSchema,
  SignEventSchema,

  IngestRecordsEventSchema, // ✅ Feature 6
  LinkDecisionsEventSchema, // ✅ Feature 7
  AttestExternalEventSchema, // ✅ Feature 8

  EnterDisputeEventSchema, // ✅ Feature 9
  ExitDisputeEventSchema, // ✅ Feature 9

  // ✅ Feature 13
  AddObligationEventSchema,
  FulfillObligationEventSchema,
  WaiveObligationEventSchema,
  AttestExecutionEventSchema,

  // ✅ Feature 15
  SetRiskEventSchema,
  AddBlastRadiusEventSchema,
  AddImpactedSystemEventSchema,
  SetRollbackPlanEventSchema,

  // ✅ Feature 15: Personal Liability Shield
  AssignResponsibilityEventSchema,
  AcceptRiskEventSchema,
]);




export type DecisionEvent = z.infer<typeof DecisionEventSchema>;


