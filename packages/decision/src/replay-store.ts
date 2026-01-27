// packages/decision/src/replay-store.ts
import type { Decision } from "./decision";
import type { DecisionEvent } from "./events";
import type { DecisionEngineOptions } from "./engine";
import { getReplaySnapshot, replayFromSnapshot, diffDecisions } from "./replay.js";

import type { DecisionStore } from "./store.js";
import type { DecisionSnapshotStore } from "./snapshots.js";

// -----------------------------
// types
// -----------------------------
export type RunCounterfactualFromStoreInput = {
  store: DecisionStore;

  /**
   * Optional snapshot store (Feature 17/18 use this for receipts/checkpoints)
   * If omitted, we still replay purely from events.
   */
  snapshotStore?: DecisionSnapshotStore;

  decision_id: string;

  locator:
    | { kind: "SEQ"; seq: number }
    | { kind: "INDEX"; index: number }
    | { kind: "EVENT_HASH"; event_hash: string };

  appended_events: DecisionEvent[];

  opts?: DecisionEngineOptions;

  engine_version?: string;
};

export type RunCounterfactualFromStoreOutput = {
  ok: boolean;

  counterfactual_id: string;
  decision_id: string;

  base_seq: number;

  snapshot_state_hash: string;

  final_state: string | null;
  final_state_hash: string | null;

  warnings: any[];

  /**
   * Raw replay result (ApplyEventResult)
   */
  result: any;

  /**
   * Snapshot we started from (ReplaySnapshot)
   */
  snapshot: any;

  /**
   * Human-readable diff between snapshot.decision and counterfactual final decision
   */
  diff?: any;
};

// -----------------------------
// main entry
// -----------------------------
export async function runCounterfactualFromStore(
  input: RunCounterfactualFromStoreInput
): Promise<RunCounterfactualFromStoreOutput> {
  const {
    store,
    snapshotStore,
    decision_id,
    locator,
    appended_events,
    opts,
    engine_version,
  } = input;

  // 1) Load canonical decision (base) + events from store
  const base = await store.getDecision(decision_id);
  if (!base) {
    throw new Error(`Decision not found: ${decision_id}`);
  }
  const rows = await store.listEvents(decision_id);

  // Normalize rows -> { event, seq, hash } where possible
  const events = rows.map((r: any) => ({
    event: r.event ?? r,
    seq: typeof r.seq === "number" ? r.seq : undefined,
    hash: typeof r.hash === "string" ? r.hash : undefined,
  }));

  // 2) Build snapshot by deterministic replay up to locator
  const snapshot = getReplaySnapshot({
    decision_id,
    base,
    events,
    locator,
    opts,
  });

  // If snapshotStore is present, you can later:
  // - hydrate checkpoint/root hashes
  // - verify receipts
  // (Feature 17–19 wiring lives here; for now we keep it optional/no-op.)
  void snapshotStore;

  // 3) Replay appended events from snapshot
  const cf = replayFromSnapshot({
    snapshot,
    appended_events,
    opts,
    engine_version,
  });

  // 4) Diff
  const diff = cf.ok ? diffDecisions(snapshot.decision as any, cf.decision as any) : null;

  return {
    ok: !!cf.ok,
    counterfactual_id: cf.counterfactual_id,
    decision_id,
    base_seq: snapshot.up_to_seq ?? snapshot.index, // best effort

    snapshot_state_hash: snapshot.state_hash,

    final_state: cf.ok ? (cf.decision as any)?.state ?? null : null,
    final_state_hash: cf.final_state_hash ?? null,

    warnings: snapshot.warnings ?? [],
    result: cf as any,
    snapshot,
    diff: diff ?? undefined,
  };
}

