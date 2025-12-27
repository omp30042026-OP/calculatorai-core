import { z } from "zod";
import type { DecisionState } from "./state-machine.js";

export const DecisionHistoryEntrySchema = z.object({
  at: z.string(),
  type: z.string(),
  actor_id: z.string().nullable(),
  reason: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});

export type DecisionHistoryEntry = z.infer<typeof DecisionHistoryEntrySchema>;

export const DecisionSchema = z.object({
  decision_id: z.string(),
  state: z.custom<DecisionState>(),
  created_at: z.string(),
  updated_at: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  history: z.array(DecisionHistoryEntrySchema).default([]),
});

export type Decision = z.infer<typeof DecisionSchema>;

