// packages/decision/src/audit-schema.ts
import { z } from "zod";

export const AuditEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(), // ISO
  type: z.string(),
  actor_id: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const DecisionAuditSchema = z.object({
  decision_id: z.string(),
  state: z.string(),
  version: z.number().int().nonnegative(),
  meta: z.record(z.string(), z.unknown()).optional(),
  recent_events: z.array(AuditEventSchema),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type DecisionAudit = z.infer<typeof DecisionAuditSchema>;

