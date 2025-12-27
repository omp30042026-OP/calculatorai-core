import { z } from "zod";
import type { DecisionState } from "./state-machine.js";

export const DecisionHistoryEntrySchema = z.object({
  at: z.string(), // ISO timestamp
  type: z.string(), // event type string
  actor_id: z.string().nullable(),
  reason: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});

export type DecisionHistoryEntry = z.infer<typeof DecisionHistoryEntrySchema>;

/**
 * V2: Decision has:
 * - meta: free-form metadata (title, owner_id, etc.)
 * - artifacts: ids/handles for pipeline outputs (snapshot_id, explain_tree_id, etc.)
 */
export const DecisionSchema = z.object({
  decision_id: z.string(),
  state: z.custom<DecisionState>(),
  created_at: z.string(),
  updated_at: z.string(),

  meta: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.unknown()).default({}),

  history: z.array(DecisionHistoryEntrySchema).default([]),
});

export type Decision = z.infer<typeof DecisionSchema>;

