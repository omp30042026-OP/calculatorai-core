// packages/decision/src/store-diff.ts
import type { Decision } from "./decision.js";
import type { DecisionEngineOptions } from "./engine.js";
import { getDecisionAtSeq } from "./store-history.js";
import type { DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

export type DecisionDiff = {
  decision_id: string;
  from_seq: number;
  to_seq: number;

  from_state: Decision["state"];
  to_state: Decision["state"];

  from_version: number;
  to_version: number;

  // shallow key diffs for meta/artifacts (good enough for infra; can deepen later)
  meta_changed: Record<string, { from: unknown; to: unknown }>;
  artifacts_changed: Record<string, { from: unknown; to: unknown }>;

  // history length changes are often useful for sanity
  from_history_len: number;
  to_history_len: number;
};

function shallowObjectDiff(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const aa = a ?? {};
  const bb = b ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    const av = (aa as any)[k];
    const bv = (bb as any)[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out[k] = { from: av, to: bv };
    }
  }
  return out;
}

export async function diffDecisionBetweenSeqs(
  store: DecisionStore,
  input: {
    decision_id: string;
    from_seq: number;
    to_seq: number;
    snapStore?: DecisionSnapshotStore;
  },
  opts: DecisionEngineOptions = {}
): Promise<{ ok: true; diff: DecisionDiff } | { ok: false; error: string }> {
  const { decision_id, from_seq, to_seq, snapStore } = input;

  if (from_seq < 0 || to_seq < 0) {
    return { ok: false, error: "seq must be >= 0" };
  }
  if (to_seq < from_seq) {
    return { ok: false, error: "to_seq must be >= from_seq" };
  }

  const a = await getDecisionAtSeq(store, decision_id, from_seq, opts, snapStore);
  const b = await getDecisionAtSeq(store, decision_id, to_seq, opts, snapStore);

  if (!a) return { ok: false, error: `decision not found at seq ${from_seq}` };
  if (!b) return { ok: false, error: `decision not found at seq ${to_seq}` };

  const diff: DecisionDiff = {
    decision_id,
    from_seq,
    to_seq,

    from_state: a.state,
    to_state: b.state,

    from_version: a.version,
    to_version: b.version,

    meta_changed: shallowObjectDiff(a.meta as any, b.meta as any),
    artifacts_changed: shallowObjectDiff(a.artifacts as any, b.artifacts as any),

    from_history_len: a.history?.length ?? 0,
    to_history_len: b.history?.length ?? 0,
  };

  return { ok: true, diff };
}

