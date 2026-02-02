// packages/decision/src/provenance/dag.ts
// Feature 10: Decision Provenance Graph (DAG Core)
//
// Goals:
// - Minimal, domain-agnostic graph primitives
// - Deterministic serialization boundaries (hash-safe)
// - Append-only friendly: edges can be added without mutating historical meaning
//
// NOTE: This file intentionally does NOT depend on business schemas.
// It only models graph relationships between decision ids.

export type DecisionId = string;

export type EdgeType =
  | "DERIVED_FROM"
  | "FORKED_FROM"
  | "OVERRIDDEN_BY"
  | "APPROVED_BY"
  | "REPLAYED_AS";

export type IsoTimestamp = string;

export type DecisionNode = {
  decision_id: DecisionId;

  // "Root" lineage anchor (original ancestor). For a brand new decision, root_id === decision_id.
  root_id: DecisionId;

  // Monotonic version within a root lineage (optional for now but useful for stores).
  // Keep as number to support sqlite schema (version INTEGER).
  version: number;

  // Canonical state hash of the decision payload (typically public_state_hash or tamper_state_hash),
  // but we keep it generic so callers can pick which hash represents "state".
  state_hash: string;

  created_at: IsoTimestamp;
};

export type ProvenanceEdge = {
  edge_id: string;

  from_decision_id: DecisionId;
  to_decision_id: DecisionId;

  edge_type: EdgeType;

  // Optional reason/evidence linkage *by hash only* to avoid leaking contents.
  // E.g. hash of a policy explanation, dispute record, evidence bundle, etc.
  reason_hash?: string;

  created_at: IsoTimestamp;
};

// For deterministic hashing/serialization you must never depend on object key order.
// We return arrays in a stable order for downstream hashing layers.
export type DagSnapshot = {
  // Node for which the snapshot is centered (often the "current" decision)
  focus: DecisionId;

  // All nodes included in the snapshot (typically reachable lineage)
  nodes: DecisionNode[];

  // All edges included in the snapshot
  edges: ProvenanceEdge[];
};

/**
 * Deterministic sort helpers (DO NOT change without versioning).
 */
export function sortNodesDeterministic(nodes: DecisionNode[]): DecisionNode[] {
  return [...nodes].sort((a, b) => {
    // primary: root_id, then decision_id, then version, then created_at
    if (a.root_id !== b.root_id) return a.root_id < b.root_id ? -1 : 1;
    if (a.decision_id !== b.decision_id) return a.decision_id < b.decision_id ? -1 : 1;
    if (a.version !== b.version) return a.version - b.version;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return 0;
  });
}

export function sortEdgesDeterministic(edges: ProvenanceEdge[]): ProvenanceEdge[] {
  return [...edges].sort((a, b) => {
    // primary: from, to, type, created_at, edge_id
    if (a.from_decision_id !== b.from_decision_id) return a.from_decision_id < b.from_decision_id ? -1 : 1;
    if (a.to_decision_id !== b.to_decision_id) return a.to_decision_id < b.to_decision_id ? -1 : 1;
    if (a.edge_type !== b.edge_type) return a.edge_type < b.edge_type ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    if (a.edge_id !== b.edge_id) return a.edge_id < b.edge_id ? -1 : 1;
    return 0;
  });
}

/**
 * Validate a node is minimally well-formed.
 */
export function assertNode(n: DecisionNode): void {
  if (!n.decision_id) throw new Error("DecisionNode missing decision_id");
  if (!n.root_id) throw new Error("DecisionNode missing root_id");
  if (typeof n.version !== "number" || !Number.isFinite(n.version)) throw new Error("DecisionNode invalid version");
  if (!n.state_hash) throw new Error("DecisionNode missing state_hash");
  if (!n.created_at) throw new Error("DecisionNode missing created_at");
}

/**
 * Validate an edge is minimally well-formed.
 */
export function assertEdge(e: ProvenanceEdge): void {
  if (!e.edge_id) throw new Error("ProvenanceEdge missing edge_id");
  if (!e.from_decision_id) throw new Error("ProvenanceEdge missing from_decision_id");
  if (!e.to_decision_id) throw new Error("ProvenanceEdge missing to_decision_id");
  if (!e.edge_type) throw new Error("ProvenanceEdge missing edge_type");
  if (!e.created_at) throw new Error("ProvenanceEdge missing created_at");
  if (e.from_decision_id === e.to_decision_id) throw new Error("ProvenanceEdge cannot be self-loop");
}

/**
 * Validate snapshot (DAG invariants).
 * - DAG means no directed cycle in the included edges.
 *   We only enforce "no cycle" if the snapshot intends to be a lineage graph.
 */
export function assertDag(snapshot: DagSnapshot): void {
  if (!snapshot.focus) throw new Error("DagSnapshot missing focus");
  const nodeMap = new Map<string, DecisionNode>();
  for (const n of snapshot.nodes) {
    assertNode(n);
    if (nodeMap.has(n.decision_id)) throw new Error(`Duplicate node: ${n.decision_id}`);
    nodeMap.set(n.decision_id, n);
  }

  for (const e of snapshot.edges) {
    assertEdge(e);
    if (!nodeMap.has(e.from_decision_id)) throw new Error(`Edge from unknown node: ${e.from_decision_id}`);
    if (!nodeMap.has(e.to_decision_id)) throw new Error(`Edge to unknown node: ${e.to_decision_id}`);
  }

  // Cycle check (Kahn's algorithm) on the induced subgraph
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();

  for (const id of nodeMap.keys()) {
    indeg.set(id, 0);
    out.set(id, []);
  }

  for (const e of snapshot.edges) {
    out.get(e.from_decision_id)!.push(e.to_decision_id);
    indeg.set(e.to_decision_id, (indeg.get(e.to_decision_id) || 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, d] of indeg.entries()) {
    if (d === 0) queue.push(id);
  }
  queue.sort();

  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    visited++;
    const children = out.get(cur)!;
    children.sort();
    for (const ch of children) {
      indeg.set(ch, (indeg.get(ch) || 0) - 1);
      if (indeg.get(ch) === 0) {
        queue.push(ch);
        queue.sort();
      }
    }
  }

  if (visited !== nodeMap.size) {
    throw new Error("DagSnapshot contains a cycle (not a DAG)");
  }
}

/**
 * Convenience: Build a minimal node from known pieces.
 */
export function makeNode(params: Omit<DecisionNode, never>): DecisionNode {
  assertNode(params);
  return { ...params };
}

/**
 * Convenience: Build an edge with a caller-supplied edge_id.
 */
export function makeEdge(params: Omit<ProvenanceEdge, never>): ProvenanceEdge {
  assertEdge(params);
  return { ...params };
}

/**
 * Produce a deterministic snapshot (sorted nodes + edges).
 * This is what we will hash in Feature 10.2 (graph hash).
 */
export function canonicalizeSnapshot(snapshot: DagSnapshot): DagSnapshot {
  const nodes = sortNodesDeterministic(snapshot.nodes);
  const edges = sortEdgesDeterministic(snapshot.edges);
  const canon = { focus: snapshot.focus, nodes, edges };
  // optional invariants
  assertDag(canon);
  return canon;
}

