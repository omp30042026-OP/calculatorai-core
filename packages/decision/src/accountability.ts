import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type DecisionAccountability = {
  // who is responsible for the outcome (business owner)
  owner_id?: string;

  // who created the decision record (usually first actor)
  created_by?: string;

  // who last changed it (latest event actor)
  last_actor_id?: string;

  // simple per-actor activity counter
  actor_event_counts: Record<string, number>;
};

function normActorId(actor_id: unknown): string | null {
  if (typeof actor_id !== "string") return null;
  const s = actor_id.trim();
  return s.length ? s : null;
}

export function ensureAccountability(decision: Decision): Decision {
  const acc = (decision as any).accountability as DecisionAccountability | undefined;

  if (acc && acc.actor_event_counts) return decision;

  const ownerFromMeta =
    (decision as any).meta && typeof (decision as any).meta.owner_id === "string"
      ? String((decision as any).meta.owner_id)
      : undefined;

  (decision as any).accountability = {
    owner_id: ownerFromMeta,
    created_by: undefined,
    last_actor_id: undefined,
    actor_event_counts: {},
  } satisfies DecisionAccountability;

  return decision;
}

export function applyAccountability(decision: Decision, event: DecisionEvent): Decision {
  ensureAccountability(decision);

  const acc = (decision as any).accountability as DecisionAccountability;

  // prefer meta.owner_id as durable owner signal
  const metaOwner =
    (decision as any).meta && typeof (decision as any).meta.owner_id === "string"
      ? String((decision as any).meta.owner_id)
      : undefined;

  if (metaOwner) acc.owner_id = metaOwner;

  const actor = normActorId((event as any).actor_id);
  if (actor) {
    // first actor becomes "created_by" if not set
    if (!acc.created_by) acc.created_by = actor;

    // last touch
    acc.last_actor_id = actor;

    // counter
    acc.actor_event_counts[actor] = (acc.actor_event_counts[actor] ?? 0) + 1;
  }

  return decision;
}
