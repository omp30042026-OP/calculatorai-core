// packages/decision/src/replay-runtime.ts
import crypto from "node:crypto";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionStore } from "./store.js";

export type ReplayMode = "ROLLBACK_ONLY" | "REPLAY_FULL" | "COUNTERFACTUAL_FORK";

export type CounterfactualOverrides = {
  // simplest + safest: patch the decision JSON at the fork point
  decision_patch?: Record<string, any>;

  // event-level overrides (optional)
  replace_approver_id?: string; // rewrite APPROVE actor / meta if needed
  obligations_outcomes?: Record<string, "FULFILLED" | "FAILED" | "WAIVED">; // keyed by obligation_id

  // if you want to re-simulate with new data
  replace_amount?: { value: number; currency: string };
};

export type ReplayInput = {
  source_decision_id: string;
  up_to_seq: number;
  mode: ReplayMode;

  // only for COUNTERFACTUAL_FORK
  new_decision_id?: string;
  overrides?: CounterfactualOverrides;

  at?: string; // optional audit timestamp for fork metadata
};

export type ReplayResult = {
  ok: boolean;
  mode: ReplayMode;

  source_decision_id: string;
  up_to_seq: number;

  base_decision: Decision;
  base_events: Array<{ seq: number; event: DecisionEvent }>;

  // present if REPLAY_FULL or COUNTERFACTUAL_FORK
  final_decision?: Decision;
  final_events?: Array<{ seq: number; event: DecisionEvent }>;

  // present if COUNTERFACTUAL_FORK
  fork_decision_id?: string;

  applied_overrides?: any;

  meta: {
    computed_at: string;
    determinism_note: string;
  };
};

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: any): any => {
    if (v === null) return null;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeForkId(source_decision_id: string, up_to_seq: number, overrides: any): string {
  // deterministic fork id (so same counterfactual = same id)
  const h = sha256Hex(
    stableStringify({
      kind: "COUNTERFACTUAL_FORK_V1",
      source_decision_id,
      up_to_seq,
      overrides: overrides ?? null,
    })
  ).slice(0, 16);
  return `dec_fork_${source_decision_id}_${up_to_seq}_${h}`;
}

function applyDecisionPatch(base: any, patch?: Record<string, any>) {
  if (!patch) return base;
  return { ...base, ...patch };
}

function rewriteEventCounterfactual(ev: any, o?: CounterfactualOverrides): any {
  if (!o) return ev;

  // Replace amount in places you already support
  if (o.replace_amount) {
    const amt = { value: o.replace_amount.value, currency: o.replace_amount.currency };
    if (typeof ev === "object" && ev) {
      if (ev.type === "CREATE" || ev.type === "SIMULATE" || ev.type === "VALIDATE") {
        ev.amount = ev.amount ?? amt;
        ev.fields = ev.fields ?? {};
        ev.fields.amount = ev.fields.amount ?? amt;
      }
    }
  }

  // Replace approver in APPROVE
  if (o.replace_approver_id && ev?.type === "APPROVE") {
    ev.actor_id = o.replace_approver_id;
    ev.meta = ev.meta ?? {};
    ev.meta.counterfactual_replace_approver_id = o.replace_approver_id;
  }

  // Obligation outcomes override (if you have an event type for it)
  if (o.obligations_outcomes && ev?.type === "OBLIGATION_RESOLVE") {
    const id = ev?.obligation_id;
    if (id && o.obligations_outcomes[id]) {
      ev.outcome = o.obligations_outcomes[id];
      ev.meta = ev.meta ?? {};
      ev.meta.counterfactual_override = true;
    }
  }

  return ev;
}

/**
 * Feature 16 core:
 * - loads decision + events
 * - splits events at up_to_seq
 * - returns rollback snapshot (base)
 * - optionally replays forward or forks with overrides
 *
 * NOTE: This does NOT persist by itself. Persisting fork is step 2.
 */
export async function replayDecisionRuntime(store: DecisionStore, input: ReplayInput): Promise<ReplayResult> {
  const computed_at = new Date().toISOString();

  const decision = await store.getDecision(input.source_decision_id);
  if (!decision) {
    return {
      ok: false,
      mode: input.mode,
      source_decision_id: input.source_decision_id,
      up_to_seq: input.up_to_seq,
      base_decision: {} as any,
      base_events: [],
      meta: { computed_at, determinism_note: "Decision not found" },
    };
  }

  const events = await store.listEvents(input.source_decision_id);
  const up = Math.max(0, Math.floor(input.up_to_seq));

  const base_events = events.filter((e) => e.seq <= up).map((e) => ({ seq: e.seq, event: e.event }));
  const tail_events = events.filter((e) => e.seq > up).map((e) => ({ seq: e.seq, event: e.event }));

  // IMPORTANT: Your determinism relies on:
  // - stable event order by seq
  // - ev.at filled from row.at (you already do this in sqlite-store)
  // - canonical state hashing at receipt write time (already done)
  //
  // For runtime-level replay, we rely on your existing store-engine applyEvent logic.
  //
  // So here we only prepare "what to apply", not the reducer itself.
  const base_decision: Decision = decision; // reducer will produce a true base decision in step 2

  if (input.mode === "ROLLBACK_ONLY") {
    return {
      ok: true,
      mode: input.mode,
      source_decision_id: input.source_decision_id,
      up_to_seq: up,
      base_decision,
      base_events,
      meta: {
        computed_at,
        determinism_note: "Rollback-only prepared. Use store-engine reducer to materialize exact base decision JSON.",
      },
    };
  }

  const overrides = input.overrides ?? null;

  const rewritten_tail = tail_events.map((x) => ({
    seq: x.seq,
    event: rewriteEventCounterfactual(structuredClone(x.event as any), overrides ?? undefined),
  }));

  if (input.mode === "REPLAY_FULL") {
    return {
      ok: true,
      mode: input.mode,
      source_decision_id: input.source_decision_id,
      up_to_seq: up,
      base_decision,
      base_events,
      final_decision: undefined, // materialized in step 2
      final_events: [...base_events, ...rewritten_tail],
      applied_overrides: overrides,
      meta: {
        computed_at,
        determinism_note: "Replay-full prepared. Use store-engine reducer to materialize final decision JSON.",
      },
    };
  }

  // COUNTERFACTUAL_FORK
  const fork_decision_id =
    input.new_decision_id && input.new_decision_id.trim().length
      ? input.new_decision_id.trim()
      : makeForkId(input.source_decision_id, up, overrides);

  return {
    ok: true,
    mode: input.mode,
    source_decision_id: input.source_decision_id,
    up_to_seq: up,
    base_decision,
    base_events,
    final_decision: undefined, // materialized in step 2
    final_events: [...base_events, ...rewritten_tail],
    fork_decision_id,
    applied_overrides: overrides,
    meta: {
      computed_at,
      determinism_note:
        "Counterfactual fork prepared. Step 2 will persist fork decision, DAG edge, and receipts.",
    },
  };
}

