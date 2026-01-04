import { merkleRootHex } from "./merkle.js";
import type { DecisionSnapshot } from "./snapshots.js";
import type { DecisionStore } from "./store.js";
import { buildConsistencyProof } from "./merkle-consistency.js";

export async function verifySnapshotConsistency(
  store: DecisionStore,
  older: DecisionSnapshot,
  newer: DecisionSnapshot
) {
  if (newer.up_to_seq <= older.up_to_seq) {
    return { ok: false, reason: "New snapshot is not newer" };
  }

  if (!older.root_hash || !newer.root_hash) {
    return { ok: false, reason: "Missing root hashes" };
  }

  const events = await store.listEvents(newer.decision_id);
  const hashes = events
    .filter(e => e.seq <= newer.up_to_seq)
    .map(e => e.hash!)
    .filter(Boolean);

  const proof = buildConsistencyProof(hashes, older.up_to_seq);

  const recomputed_old = merkleRootHex(hashes.slice(0, older.up_to_seq));
  const recomputed_new = merkleRootHex(hashes);

  return {
    ok:
      recomputed_old === older.root_hash &&
      recomputed_new === newer.root_hash,
    decision_id: newer.decision_id,
    old_seq: older.up_to_seq,
    new_seq: newer.up_to_seq,
    expected_old_root: older.root_hash,
    computed_old_root: recomputed_old,
    expected_new_root: newer.root_hash,
    computed_new_root: recomputed_new,
    proof,
  };
}

