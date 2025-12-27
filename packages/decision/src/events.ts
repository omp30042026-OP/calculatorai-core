import { z } from "zod";
import type { DecisionEventType } from "./state-machine.js";

const BaseEventSchema = z.object({
  type: z.custom<DecisionEventType>(),
  actor_id: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const ValidateEventSchema = BaseEventSchema.extend({
  type: z.literal("VALIDATE"),
});

export const SimulateEventSchema = BaseEventSchema.extend({
  type: z.literal("SIMULATE"),
  simulation_snapshot_id: z.string().optional(), // V2 artifact hook
});

export const ExplainEventSchema = BaseEventSchema.extend({
  type: z.literal("EXPLAIN"),
  explain_tree_id: z.string().optional(), // V2 artifact hook
});

export const ApproveEventSchema = BaseEventSchema.extend({
  type: z.literal("APPROVE"),
});

export const RejectEventSchema = BaseEventSchema.extend({
  type: z.literal("REJECT"),
  reason: z.string().optional(),
});

export const DecisionEventSchema = z.union([
  ValidateEventSchema,
  SimulateEventSchema,
  ExplainEventSchema,
  ApproveEventSchema,
  RejectEventSchema,
]);

export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

