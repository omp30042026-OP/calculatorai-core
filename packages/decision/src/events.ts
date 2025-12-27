import { z } from "zod";

/**
 * Event payloads are intentionally small and generic.
 * Any company-specific data goes in meta (adapter layer).
 */

export const DecisionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("VALIDATE"),
    actor_id: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),

  z.object({
    type: z.literal("SIMULATE"),
    actor_id: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),

  z.object({
    type: z.literal("EXPLAIN"),
    actor_id: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),

  z.object({
    type: z.literal("APPROVE"),
    actor_id: z.string().optional(),
    reason: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),

  z.object({
    type: z.literal("REJECT"),
    actor_id: z.string().optional(),
    reason: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type DecisionEvent = z.infer<typeof DecisionEventSchema>;
