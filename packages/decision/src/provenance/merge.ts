// packages/decision/src/provenance/merge.ts
import type { DagSnapshot, DecisionNode, ProvenanceEdge } from "./dag.js";
import { sortEdgesDeterministic, sortNodesDeterministic } from "./dag.js";
import { computeGraphHash } from "./graph-hash.js";

type DecisionId = string;

export type MergeConflict =
  | {
      kind: "NODE_STATE_HASH_MISMATCH";
      decision_id: DecisionId;
      left_state_hash: string;
      right_state_hash: string;
    }
  | {
      kind: "EDGE_CONFLICT";
      edge_id: string;
      reason: string;
    };

export type MergeResult = {
  merged: DagSnapshot;
  merged_graph_hash: string;
  conflicts: MergeConflict[];
  stats: {
    left_nodes: number;
    right_nodes: number;
    left_edges: number;
    right_edges: number;
    merged_nodes: number;
    merged_edges: number;
    conflicts: number;
  };
};

function keyEdge(e: ProvenanceEdge): string {
  // Identity by content (edge_id may differ across orgs)
  return `${e.from_decision_id}::${e.to_decision_id}::${e.edge_type}::${e.created_at}`;
}

export function mergeDagSnapshots(params: {
  focus?: DecisionId;
  left: DagSnapshot;
  right: DagSnapshot;
}): MergeResult {
  const focus = params.focus ?? params.left.focus;

  const conflicts: MergeConflict[] = [];

  // ---- Merge nodes by decision_id, detect state_hash mismatch
  const leftNodes = new Map(params.left.nodes.map((n) => [n.decision_id, n] as const));
  const rightNodes = new Map(params.right.nodes.map((n) => [n.decision_id, n] as const));

  const mergedNodes = new Map<DecisionId, DecisionNode>();

  for (const [id, ln] of leftNodes) mergedNodes.set(id, ln);

  for (const [id, rn] of rightNodes) {
    const existing = mergedNodes.get(id);
    if (!existing) {
      mergedNodes.set(id, rn);
      continue;
    }
    // conflict if state_hash differs
    if (existing.state_hash !== rn.state_hash) {
      conflicts.push({
        kind: "NODE_STATE_HASH_MISMATCH",
        decision_id: id,
        left_state_hash: existing.state_hash,
        right_state_hash: rn.state_hash,
      });

      // deterministic choice: keep the one with later created_at (or higher version if present)
      const pick = pickNodeDeterministic(existing, rn);
      mergedNodes.set(id, pick);
    }
  }

  // ---- Merge edges: de-duplicate by content key
  const mergedEdgesByKey = new Map<string, ProvenanceEdge>();
  const leftEdges = params.left.edges;
  const rightEdges = params.right.edges;

  for (const e of leftEdges) {
    mergedEdgesByKey.set(keyEdge(e), e);
  }

  for (const e of rightEdges) {
    const k = keyEdge(e);
    const existing = mergedEdgesByKey.get(k);
    if (!existing) {
      mergedEdgesByKey.set(k, e);
      continue;
    }
    // If same content-key but different reason_hash, keep both? (depends)
    // For v1: keep the one that has reason_hash if the other doesn't.
    if ((existing.reason_hash ?? "") !== (e.reason_hash ?? "")) {
      // deterministic rule: prefer the one with reason_hash, else prefer lexicographically smaller edge_id
      const pick = pickEdgeDeterministic(existing, e);
      mergedEdgesByKey.set(k, pick);
    }
  }

  const merged: DagSnapshot = {
    focus,
    nodes: sortNodesDeterministic([...mergedNodes.values()]),
    edges: sortEdgesDeterministic([...mergedEdgesByKey.values()]),
  };

  const merged_graph_hash = computeGraphHash(merged);

  return {
    merged,
    merged_graph_hash,
    conflicts,
    stats: {
      left_nodes: params.left.nodes.length,
      right_nodes: params.right.nodes.length,
      left_edges: params.left.edges.length,
      right_edges: params.right.edges.length,
      merged_nodes: merged.nodes.length,
      merged_edges: merged.edges.length,
      conflicts: conflicts.length,
    },
  };
}

function pickNodeDeterministic(a: DecisionNode, b: DecisionNode): DecisionNode {
  // Prefer higher version, then later created_at, then lexicographically smaller state_hash to be stable
  if (a.version !== b.version) return a.version > b.version ? a : b;
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? a : b;
  return a.state_hash < b.state_hash ? a : b;
}

function pickEdgeDeterministic(a: ProvenanceEdge, b: ProvenanceEdge): ProvenanceEdge {
  const ar = a.reason_hash ?? "";
  const br = b.reason_hash ?? "";
  if (ar && !br) return a;
  if (br && !ar) return b;
  // stable fallback
  return a.edge_id < b.edge_id ? a : b;
}
