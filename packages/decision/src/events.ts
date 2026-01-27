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

const ActorTypeSchema = z.enum(["human", "service", "system", "agent"]).optional();

const TrustZoneCompatSchema = z
  .enum(["TEAM", "ORG", "VENDOR", "EXTERNAL", "INTERNAL", "PARTNER", "PUBLIC"])
  .transform((z) => {
    if (z === "INTERNAL") return "ORG";
    if (z === "PUBLIC") return "EXTERNAL";
    if (z === "PARTNER") return "VENDOR"; // or ORG depending on your semantics
    return z;
  });


// ✅ Feature 17: Trust Boundary (foundation)
const TrustZoneSchema = z.enum([
  "INTERNAL",
  "PARTNER",
  "VENDOR",
  "PUBLIC",
  // legacy/back-compat (because your stored trust policy already uses ORG)
  "ORG",
  "TEAM",
  "EXTERNAL",
]).optional();

const EventOriginSchema = z
  .object({
    system: z.string().optional(),
    source: z.string().optional(),
    ip: z.string().optional(),
    user_agent: z.string().optional(),
    request_id: z.string().optional(),
  })
  .partial()
  .optional();

const TrustBoundarySchema = z
  .object({
    zone: TrustZoneSchema,
    origin: EventOriginSchema,
    asserted_by: z.string().optional(),
    attested: z.boolean().optional(),
  })
  .partial()
  .optional();


// -----------------------------
// ✅ Feature 17: Trust Boundary foundation (schemas)
// -----------------------------
const TrustZoneIdSchema = z.string().trim().min(1);

const TrustOriginSchema = z
  .object({
    zone: TrustZoneSchema,                // e.g. "INTERNAL", "PARTNER", "PUBLIC"
    org_id: z.string().optional(),        // ✅ Feature 19: which org asserted this
    system: z.string().optional(),        // e.g. "lightspeed", "shopify", "etl-job"
    channel: z.string().optional(),       // e.g. "api", "ui", "batch", "webhook"
    ip: z.string().optional(),
    tenant_id: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .partial();

// ✅ Feature 17: Evidence + Attestation trust
const EvidenceRefSchema = z.object({
  artifact_id: z.string(),
  type: z.enum(["DOCUMENT", "DATASET", "MODEL_OUTPUT", "EXTERNAL_PROOF"]),
  hash: z.string(),
  source_system: z.string().optional(),
  captured_at: z.string().optional(), // ISO
}).partial();

const AttestationRefSchema = z.object({
  attestor_id: z.string(),      // e.g. "docusign", "plaid"
  payload_hash: z.string(),
  signature: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).partial();

const TrustEnvelopeSchema = z
  .object({
    origin: TrustOriginSchema.optional(),
    evidence: z.array(EvidenceRefSchema).optional(),
    attestations: z.array(AttestationRefSchema).optional(),
    claimed_by: z.string().optional(),
    asserted_at: z.string().optional(),
  })
  .partial();

const TrustPolicySchema = z
  .object({
    enabled: z.boolean().default(true),

    // If present, any event without origin.zone is BLOCKed (unless exempt type)
    require_origin_zone: z.boolean().default(false),

    // Allowed origin zones for writes (if empty => allow all)
    allowed_origin_zones: z.array(TrustZoneSchema).default([]),

    // Optional: deny-list zones
    denied_origin_zones: z.array(TrustZoneSchema).default([]),


    // ✅ Evidence trust
    min_evidence: z.number().int().nonnegative().default(0),

    // ✅ Attestation trust
    required_attestors: z.array(z.string()).default([]),
    min_attestation_confidence: z.number().min(0).max(1).default(0),

    // Event types that are exempt from origin requirement (bootstrap)
    exempt_event_types: z.array(z.string()).default([
      "VALIDATE",
      "SIMULATE",
      "EXPLAIN",
      "SET_TRUST_POLICY",
      "ASSERT_TRUST_ORIGIN",
      "ATTACH_ARTIFACTS",
    ]),
  })
  .partial();

// -----------------------------
// Base event
// -----------------------------
const BaseEventSchema = z.object({
  type: z.custom<DecisionEventType>(),
  actor_id: ActorIdSchema,
  actor_type: ActorTypeSchema,
  meta: z.record(z.string(), z.unknown()).optional(),

  // ✅ Feature 17 foundation: trust envelope on every event
  trust: TrustEnvelopeSchema.optional(),
});





// -----------------------------
// Core lifecycle events
// -----------------------------
export const ValidateEventSchema = BaseEventSchema.extend({
  type: z.literal("VALIDATE"),
});

export const SetAmountEvent = z.object({
  type: z.literal("SET_AMOUNT"),
  actor_id: z.string(),
  actor_type: z.enum(["human", "system"]).optional(),
  amount: z.object({
    value: z.number(),
    currency: z.string().optional(),
  }),
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
// ✅ Feature 17: Trust boundary events
// -----------------------------
export const SetTrustPolicyEventSchema = BaseEventSchema.extend({
  type: z.literal("SET_TRUST_POLICY"),
  policy: TrustPolicySchema,
});

export const AssertTrustOriginEventSchema = BaseEventSchema.extend({
  type: z.literal("ASSERT_TRUST_ORIGIN"),
  origin: TrustOriginSchema,
});


// -----------------------------
// ✅ Feature 18: Autonomous Decision Agents (Constrained AI)
// -----------------------------

export const AgentProposeEventSchema = BaseEventSchema.extend({
  type: z.literal("AGENT_PROPOSE"),
  // free-form proposal payload (LLM output, plan, recommendation, etc.)
  proposal: z.unknown().optional(),

  // optional: what action the agent is proposing the human/system should take next
  proposed_event_type: z.string().optional(),

  // optional: a pointer to evidence artifacts the agent relied on
  evidence_refs: z.array(z.string()).optional(),
});

export const AgentTriggerObligationEventSchema = BaseEventSchema.extend({
  type: z.literal("AGENT_TRIGGER_OBLIGATION"),
  obligation_id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  due_at: z.string().optional(), // ISO
  tags: z.record(z.string(), z.string()).optional(),
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

  // ✅ Feature 17
  SetTrustPolicyEventSchema,
  AssertTrustOriginEventSchema,

  // ✅ Feature 18
  AgentProposeEventSchema,
  AgentTriggerObligationEventSchema,

  SetAmountEvent,

]);




export type DecisionEvent = z.infer<typeof DecisionEventSchema>;


