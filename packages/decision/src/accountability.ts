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


   // last actor type (human/service/system/agent)
  last_actor_type?: string;

  // per-actor-type counters (human/service/system/agent)
  actor_type_counts: Record<string, number>;

  // optional: per (actor_type, actor_id) counters for audit
  actor_type_event_counts: Record<string, Record<string, number>>;


};

function normActorId(actor_id: unknown): string | null {
  if (typeof actor_id !== "string") return null;
  const s = actor_id.trim();
  return s.length ? s : null;
}

export function ensureAccountability(decision: Decision): Decision {
  const acc = (decision as any).accountability as DecisionAccountability | undefined;

  if (acc && acc.actor_event_counts && acc.actor_type_counts && acc.actor_type_event_counts) {
    return decision;
  }

  const ownerFromMeta =
    (decision as any).meta && typeof (decision as any).meta.owner_id === "string"
      ? String((decision as any).meta.owner_id)
      : undefined;

  (decision as any).accountability = {
    owner_id: ownerFromMeta,
    created_by: undefined,
    last_actor_id: undefined,
    last_actor_type: undefined,
    actor_event_counts: {},

    // ✅ Feature 18
    actor_type_counts: {},
    actor_type_event_counts: {},
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

  // ✅ compute actor_type BEFORE using it
  const actor_type =
    typeof (event as any).actor_type === "string" && (event as any).actor_type.trim().length
      ? String((event as any).actor_type).trim()
      : "unknown";

  if (actor) {
    // first actor becomes "created_by" if not set
    if (!acc.created_by) acc.created_by = actor;

    // last touch
    acc.last_actor_id = actor;

    // counter
    acc.actor_event_counts[actor] = (acc.actor_event_counts[actor] ?? 0) + 1;

    // ✅ optional: store last actor type if you added this field
    (acc as any).last_actor_type = actor_type;

    // ✅ optional: type counts (if you added these in your extension)
    (acc as any).actor_type_counts = (acc as any).actor_type_counts ?? {};
    (acc as any).actor_type_counts[actor_type] =
      ((acc as any).actor_type_counts[actor_type] ?? 0) + 1;

    // ✅ optional: type->event counts (if you added these)
    (acc as any).actor_type_event_counts = (acc as any).actor_type_event_counts ?? {};
    const byType = (acc as any).actor_type_event_counts[actor_type] ?? {};
    const et = typeof (event as any).type === "string" ? (event as any).type : "UNKNOWN";
    byType[et] = (byType[et] ?? 0) + 1;
    (acc as any).actor_type_event_counts[actor_type] = byType;
  }

  return decision;
}