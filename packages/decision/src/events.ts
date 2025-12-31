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

  // If omitted, treated as "system" by accountability layer
  actor_id: ActorIdSchema,

  // Optional future signal (not required)
  actor_type: ActorTypeSchema,

  meta: z.record(z.string(), z.unknown()).optional(),
});

// -----------------------------
// Events
// -----------------------------
export const ValidateEventSchema = BaseEventSchema.extend({
  type: z.literal("VALIDATE"),
});

export const SimulateEventSchema = BaseEventSchema.extend({
  type: z.literal("SIMULATE"),
  simulation_snapshot_id: z.string().optional(), // artifact hook
});

export const ExplainEventSchema = BaseEventSchema.extend({
  type: z.literal("EXPLAIN"),
  explain_tree_id: z.string().optional(), // artifact hook
});

export const ApproveEventSchema = BaseEventSchema.extend({
  type: z.literal("APPROVE"),
});

export const RejectEventSchema = BaseEventSchema.extend({
  type: z.literal("REJECT"),
  reason: z.string().optional(),
});

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

// ✅ Feature 16: SIGN (attestation/signature record)
export const SignEventSchema = BaseEventSchema.extend({
  type: z.literal("SIGN"),

  // who is signing (defaults to actor_id if omitted)
  signer_id: z.string().optional(),

  // optional human meaning
  role: z.string().optional(),

  // signature metadata
  method: z.enum(["HMAC", "ED25519", "RSA", "EIP191", "CUSTOM"]).optional(),

  // hash of canonical payload being attested
  payload_hash: z.string(),

  // signature/proof material
  signature: z.string(),

  // key reference (optional)
  key_id: z.string().optional(),
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
  SignEventSchema, // ✅ Feature 16
]);

export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

