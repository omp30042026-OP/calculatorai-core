// packages/decision/src/store-verify-anchored-snapshot.ts
import type { DecisionSnapshotStore } from "./snapshots.js";
import type { DecisionAnchorStore, DecisionAnchorRecord } from "./anchors.js";
import { computeAnchorHash } from "./anchors.js";

export type VerifyAnchoredSnapshotResult =
  | {
      ok: true;
      decision_id: string;
      up_to_seq: number;
      anchor: DecisionAnchorRecord;
      message: string;
    }
  | {
      ok: false;
      decision_id: string;
      up_to_seq: number;
      code:
        | "NO_SNAPSHOT"
        | "NO_ANCHOR"
        | "ANCHOR_HASH_MISMATCH"
        | "ANCHOR_CHECKPOINT_MISMATCH"
        | "ANCHOR_ROOT_MISMATCH"
        | "PREV_HASH_MISMATCH";
      message: string;
      snapshot_checkpoint_hash?: string | null;
      snapshot_root_hash?: string | null;
      anchor?: DecisionAnchorRecord | null;
      expected?: string | null;
      actual?: string | null;
    };

type AnchorLookupCapableStore = DecisionAnchorStore & {
  findAnchorByCheckpoint?: (
    decision_id: string,
    snapshot_up_to_seq: number
  ) => Promise<DecisionAnchorRecord | null>;
};

export async function verifySnapshotIsAnchored(
  snapshotStore: DecisionSnapshotStore,
  anchorStore: AnchorLookupCapableStore,
  input: { decision_id: string; up_to_seq?: number }
): Promise<VerifyAnchoredSnapshotResult> {
  const decision_id = input.decision_id;

  const snap =
    input.up_to_seq && input.up_to_seq > 0
      ? null // we’ll fetch latest then compare if caller wants a specific seq but store only supports latest snapshot
      : null;

  const latestSnap = await snapshotStore.getLatestSnapshot(decision_id);
  if (!latestSnap) {
    return {
      ok: false,
      decision_id,
      up_to_seq: input.up_to_seq ?? 0,
      code: "NO_SNAPSHOT",
      message: "No snapshot found.",
    };
  }

  const up_to_seq = input.up_to_seq ?? latestSnap.up_to_seq;

  // If caller asked for a specific up_to_seq but latest snapshot is different, we still verify latest only
  // unless you later add snapshotStore.getSnapshotAtSeq(). For now keep it simple/consistent.
  if (up_to_seq !== latestSnap.up_to_seq) {
    // best-effort: we can only verify latest snapshot with current interface
    // treat as no snapshot for that seq
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "NO_SNAPSHOT",
      message:
        `Snapshot at up_to_seq=${up_to_seq} is not available via getLatestSnapshot. ` +
        `Latest is up_to_seq=${latestSnap.up_to_seq}.`,
    };
  }

  const snapshot_checkpoint_hash = (latestSnap as any).checkpoint_hash ?? null;
  const snapshot_root_hash = (latestSnap as any).root_hash ?? null;

  const anchor =
    anchorStore.findAnchorByCheckpoint
      ? await anchorStore.findAnchorByCheckpoint(decision_id, up_to_seq)
      : null;

  if (!anchor) {
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "NO_ANCHOR",
      message: "No anchor found for this snapshot checkpoint.",
      snapshot_checkpoint_hash,
      snapshot_root_hash,
      anchor: null,
    };
  }

  // 1) snapshot ↔ anchor payload consistency checks
  if ((anchor.checkpoint_hash ?? null) !== (snapshot_checkpoint_hash ?? null)) {
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "ANCHOR_CHECKPOINT_MISMATCH",
      message: "Anchor checkpoint_hash does not match snapshot checkpoint_hash.",
      snapshot_checkpoint_hash,
      snapshot_root_hash,
      anchor,
      expected: snapshot_checkpoint_hash ?? null,
      actual: anchor.checkpoint_hash ?? null,
    };
  }

  if ((anchor.root_hash ?? null) !== (snapshot_root_hash ?? null)) {
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "ANCHOR_ROOT_MISMATCH",
      message: "Anchor root_hash does not match snapshot root_hash.",
      snapshot_checkpoint_hash,
      snapshot_root_hash,
      anchor,
      expected: snapshot_root_hash ?? null,
      actual: anchor.root_hash ?? null,
    };
  }

  // 2) anchor record hash integrity
  const computed_hash = computeAnchorHash({
    seq: anchor.seq,
    at: anchor.at,
    decision_id: anchor.decision_id,
    snapshot_up_to_seq: anchor.snapshot_up_to_seq,
    checkpoint_hash: anchor.checkpoint_hash ?? null,
    root_hash: anchor.root_hash ?? null,
    prev_hash: anchor.prev_hash ?? null,
  });

  if ((anchor.hash ?? null) !== computed_hash) {
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "ANCHOR_HASH_MISMATCH",
      message: "Anchor hash does not match computed hash.",
      snapshot_checkpoint_hash,
      snapshot_root_hash,
      anchor,
      expected: computed_hash,
      actual: anchor.hash ?? null,
    };
  }

  // 3) prev_hash sanity: if this is the first anchor in DB, prev_hash should be null.
  // We can’t always know if it’s first without list/getLast, but we can enforce:
  // if seq === 1 => prev_hash must be null.
  if (anchor.seq === 1 && (anchor.prev_hash ?? null) !== null) {
    return {
      ok: false,
      decision_id,
      up_to_seq,
      code: "PREV_HASH_MISMATCH",
      message: "First anchor must have prev_hash=null.",
      anchor,
      expected: null,
      actual: anchor.prev_hash ?? null,
    };
  }

  return {
    ok: true,
    decision_id,
    up_to_seq,
    anchor,
    message: "Snapshot is anchored and anchor integrity checks passed.",
  };
}
