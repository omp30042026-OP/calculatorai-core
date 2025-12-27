import { z } from "zod";

/**
 * v1 Decision Contract:
 * - Stable input shape for parsing/validation across systems.
 * - Forward compatible: allow unknown keys via passthrough where safe.
 */

export const DecisionVersionSchema = z.literal("v1");
export type DecisionVersion = z.infer<typeof DecisionVersionSchema>;

export const ISODateSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid ISO date string");

export const DateRangeSchema = z.object({
  start: ISODateSchema,
  end: ISODateSchema,
});

export const MetricKeySchema = z.enum(["unit_price", "unit_cost", "volume"]);

export const ChangeSchema = z
  .object({
    change_id: z.string().min(1),
    item_id: z.string().min(1),
    metric: MetricKeySchema,
    // absolute value override (eg price=12.5, cost=6.2, volume=1000)
    value: z.number().finite(),
    effective: DateRangeSchema.optional(),
    // optional metadata
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const DecisionSchema = z
  .object({
    version: DecisionVersionSchema,
    decision_id: z.string().min(1),
    horizon: DateRangeSchema,
    // the engine input: changes to apply
    changes: z.array(ChangeSchema).default([]),
    // optional metadata for customer systems
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type Decision = z.infer<typeof DecisionSchema>;

export function parseDecision(input: unknown): Decision {
  return DecisionSchema.parse(input);
}
