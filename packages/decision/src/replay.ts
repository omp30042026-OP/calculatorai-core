// packages/decision/src/replay.ts
import crypto from "node:crypto";
import type { Decision } from "./decision";
import type { DecisionEvent } from "./events";
import type { DecisionEngineOptions, ApplyEventResult } from "./engine";
import { replayDecision, applyDecisionEvent } from "./engine";
import { computeDecisionStateHash } from "./state-hash.js";

/**
 * Feature 16 — Deterministic Replay Core
 *
 * This module is intentionally:
 * - Pure (no IO / no store dependency)
 * - Deterministic (stable hashing / stable stringify)
 * - Composable (works with your engine.ts + store-engine.ts)
 */

// -----------------------------
// stable hashing helpers
// -----------------------------
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





/**
 * Used to build deterministic counterfactual IDs.
 * IMPORTANT: opts.now may be a function; that would make hashing nondeterministic.
 * We hash only a "sanitized" options object.
 */
function sanitizeEngineOptions(opts?: DecisionEngineOptions): any {
  const o: any = opts ?? {};
  const out: any = { ...o };

  // remove functions / non-deterministic fields
  if (typeof out.now === "function") delete out.now;

  // policies are functions -> nondeterministic for hashing (still used for replay)
  if (out.policies) delete out.policies;

  return out;
}

// -----------------------------
// types
// -----------------------------
export type ReplayLocator =
  | { kind: "INDEX"; index: number } // 0..events.length
  | { kind: "SEQ"; seq: number } // 1..N (caller maps seq -> index)
  | { kind: "EVENT_HASH"; event_hash: string }; // caller maps hash -> index

export type ReplaySnapshot = {
  decision_id: string | null;

  /** Replay base decision */
  base: Decision;

  /**
   * Events that were applied to reach `decision`.
   * Always equals input events slice(0, index).
   */
  applied_events: DecisionEvent[];

  /** Index (0..events.length) meaning: number of events applied */
  index: number;

  /** Optional metadata if caller has it */
  up_to_seq?: number | null;
  up_to_event_hash?: string | null;

  /** Optional integrity hashes (present when snapshot came from snapshotStore) */
  checkpoint_hash?: string | null;
  root_hash?: string | null;
  provenance_tail_hash?: string | null;


  /** Final decision after applying applied_events */
  decision: Decision;

  /** Warnings accumulated during replay */
  warnings: any[];

  /** Deterministic hash of snapshot decision */
  state_hash: string;
};

export type CounterfactualResult = ApplyEventResult & {
  /**
   * Deterministic identifier for this counterfactual run:
   * hash(snapshot.state_hash + applied_events_hash + new_events_hash + engine_opts_hash + engine_version)
   */
  counterfactual_id: string;

  /** snapshot we started from */
  snapshot: ReplaySnapshot;

  /** events we appended for the counterfactual */
  appended_events: DecisionEvent[];

  /** state hash of final decision (if ok) */
  final_state_hash: string | null;
};

// -----------------------------
// locate helpers (optional use)
// -----------------------------
export function resolveIndexFromLocator(params: {
  events: Array<DecisionEvent | { event: DecisionEvent; seq?: number; hash?: string }>;
  locator: ReplayLocator;
}): number {
  const { events, locator } = params;

  const n = events.length;

  if (locator.kind === "INDEX") {
    const i = Math.max(0, Math.min(n, Math.floor(locator.index)));
    return i;
  }

  if (locator.kind === "SEQ") {
    const seq = Math.floor(locator.seq);
    if (!Number.isFinite(seq) || seq <= 0) return 0;

    // If caller passed seq in wrappers, map seq -> index
    for (let i = 0; i < n; i++) {
      const row: any = events[i] as any;
      const rowSeq = typeof row?.seq === "number" ? row.seq : null;
      if (rowSeq === seq) return i + 1; // apply up to this event
    }
    // if not found, best effort: clamp
    return Math.min(n, Math.max(0, seq));
  }

  // EVENT_HASH
  const h = String(locator.event_hash ?? "").trim();
  if (!h) return 0;

  for (let i = 0; i < n; i++) {
    const row: any = events[i] as any;
    const rowHash = typeof row?.hash === "string" ? row.hash : null;
    if (rowHash && rowHash === h) return i + 1;
  }

  return 0;
}

function unwrapEventRow(
  row: DecisionEvent | { event: DecisionEvent }
): DecisionEvent {
  const anyRow: any = row as any;
  return (anyRow && anyRow.event ? anyRow.event : row) as DecisionEvent;
}

// -----------------------------
// snapshot builder
// -----------------------------
export function getReplaySnapshot(params: {
  decision_id?: string | null;
  base: Decision;
  events: Array<DecisionEvent | { event: DecisionEvent; seq?: number; hash?: string }>;
  locator?: ReplayLocator; // default: end
  opts?: DecisionEngineOptions;
}): ReplaySnapshot {
  const decision_id = params.decision_id ?? null;
  const base = params.base;

  const rawRows = params.events ?? [];
  const events = rawRows.map(unwrapEventRow);

  const index =
    params.locator ? resolveIndexFromLocator({ events: rawRows as any, locator: params.locator }) : events.length;

  // We want a snapshot that is always valid.
    // So we replay step-by-step and STOP at the first failure.
    const target = Math.max(0, Math.min(events.length, index));

    let cur: Decision = base;
    let warnings: any[] = [];
    const applied_events: DecisionEvent[] = [];

    for (let i = 0; i < target; i++) {
    const ev = events[i];
    if (!ev) break; // satisfies noUncheckedIndexedAccess

    const r = applyDecisionEvent(cur, ev, params.opts);

    // accumulate warnings from each step
    warnings = [...warnings, ...((r as any).warnings ?? [])];

    if (!r.ok) {
        warnings.push({
        code: "REPLAY_SNAPSHOT_STOPPED",
        at_index: i,
        event_type: (ev as any)?.type ?? null,
        violations: (r as any).violations ?? [],
        });
        break;
    }

    cur = r.decision;
    applied_events.push(ev);
    }

    const decision = cur;
    const state_hash = computeDecisionStateHash(decision);

  // Optional: if caller provided seq/hash on wrapper rows, capture last
  let up_to_seq: number | null = null;
  let up_to_event_hash: string | null = null;

  const appliedIndex = applied_events.length;

  if (appliedIndex > 0) {
    const lastRow: any = rawRows[appliedIndex - 1] as any;
    if (typeof lastRow?.seq === "number") up_to_seq = lastRow.seq;
    if (typeof lastRow?.hash === "string") up_to_event_hash = lastRow.hash;
  }

  return {
    decision_id,
    base,
    applied_events,
    index: appliedIndex,
    up_to_seq,
    up_to_event_hash,
    checkpoint_hash: null,
    root_hash: null,
    provenance_tail_hash: null,
    decision: decision as any,
    warnings,
    state_hash,
  };
}

// -----------------------------
// counterfactual replay
// -----------------------------
export function replayFromSnapshot(params: {
  snapshot: ReplaySnapshot;
  appended_events: DecisionEvent[];
  opts?: DecisionEngineOptions;
  engine_version?: string; // optional manual version string; defaults "engine@unknown"
}): CounterfactualResult {
  const { snapshot, appended_events } = params;
  const opts = params.opts;

  // 1) Replay forward from snapshot.decision (not snapshot.base) to keep it O(k)
  const baseDecision = snapshot.decision;

  const rr = replayDecision(baseDecision, appended_events, opts);

  // 2) Deterministic counterfactual id
  const engine_version = String(params.engine_version ?? "engine@unknown");

  const snapshotEventsHash = sha256Hex(stableStringify(snapshot.applied_events));
  const appendedEventsHash = sha256Hex(stableStringify(appended_events));
  const optsHash = sha256Hex(stableStringify(sanitizeEngineOptions(opts)));

  const counterfactual_id = sha256Hex(
    stableStringify({
        decision_id: snapshot.decision_id,

        // include anything that should change the counterfactual identity
        engine_version: engine_version ?? null,

        // base snapshot identity
        up_to_seq: snapshot.up_to_seq,
        state_hash: snapshot.state_hash ?? null,
        checkpoint_hash: snapshot.checkpoint_hash ?? null,
        root_hash: snapshot.root_hash ?? null,
        provenance_tail_hash: snapshot.provenance_tail_hash ?? null,

        // the actual hypothetical inputs
        appended_events,
    })
  );

  const final_state_hash = rr.ok ? computeDecisionStateHash(rr.decision) : null;

  return {
    ...(rr as any),
    counterfactual_id,
    snapshot,
    appended_events,
    final_state_hash,
  };
}

// -----------------------------
// diffs (small + readable)
// -----------------------------
export type DecisionDiff = Array<{
  path: string;
  before: any;
  after: any;
}>;

function isObj(x: any): boolean {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function diffRec(before: any, after: any, path: string, out: DecisionDiff): void {
  if (before === after) return;

  // primitives or mismatched types -> record
  const bObj = isObj(before);
  const aObj = isObj(after);

  const bArr = Array.isArray(before);
  const aArr = Array.isArray(after);

  if ((!bObj && !bArr) || (!aObj && !aArr)) {
    out.push({ path, before, after });
    return;
  }

  if (bArr || aArr) {
    // arrays: compare by stableStringify (simple + deterministic)
    if (stableStringify(before) !== stableStringify(after)) {
      out.push({ path, before, after });
    }
    return;
  }

  // objects
  const keys = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  for (const k of Array.from(keys).sort()) {
    diffRec(before?.[k], after?.[k], path ? `${path}.${k}` : k, out);
  }
}

export function diffDecisions(before: Decision, after: Decision): DecisionDiff {
  const out: DecisionDiff = [];
  diffRec(before as any, after as any, "", out);
  return out;
}

