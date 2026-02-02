// packages/decision/src/provenance/query-engine.ts

import type { DagSnapshot, ProvenanceEdge, EdgeType } from "./dag.js";
import { sortEdgesDeterministic, sortNodesDeterministic } from "./dag.js";
import type { DagQuery, DagQueryResult, Direction } from "./query.js";

export type DecisionId = string;

function asSet<T>(xs: T[] | undefined): Set<T> | null {
  if (!xs || xs.length === 0) return null;
  return new Set(xs);
}

function dirDefault(q: DagQuery): Direction {
  if (q.kind === "LINEAGE") return q.direction ?? "UP";
  if (q.kind === "NEIGHBORS") return q.direction ?? "BOTH";
  return "BOTH";
}

function edgeAllowed(edge: ProvenanceEdge, allowed: Set<EdgeType> | null): boolean {
  if (!allowed) return true;
  return allowed.has(edge.edge_type);
}

function buildAdj(snapshot: DagSnapshot) {
  const out = new Map<DecisionId, ProvenanceEdge[]>();
  const inn = new Map<DecisionId, ProvenanceEdge[]>();

  for (const e of snapshot.edges) {
    const o = out.get(e.from_decision_id) ?? [];
    o.push(e);
    out.set(e.from_decision_id, o);

    const i = inn.get(e.to_decision_id) ?? [];
    i.push(e);
    inn.set(e.to_decision_id, i);
  }
  return { out, inn };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function runDagQuery(snapshot: DagSnapshot, query: DagQuery): DagQueryResult {
  const focus = (query as any).focus ?? snapshot.focus;

  const edgeTypes = asSet((query as any).edge_types as EdgeType[] | undefined);

  const limit = clamp((query as any).limit ?? defaultLimit(query), 1, 50_000);

  const { out, inn } = buildAdj(snapshot);

  const nodeExists = new Set(snapshot.nodes.map((n) => n.decision_id));
  const edgeById = new Map(snapshot.edges.map((e) => [e.edge_id, e] as const));

  const selectedNodes = new Set<DecisionId>();
  const selectedEdges = new Set<string>();

  const scannedEdgesCounter = { n: 0 };

  const addEdge = (e: ProvenanceEdge) => {
    scannedEdgesCounter.n++;
    if (!edgeAllowed(e, edgeTypes)) return;
    selectedEdges.add(e.edge_id);
    selectedNodes.add(e.from_decision_id);
    selectedNodes.add(e.to_decision_id);
  };

  const addNodeOnly = (id: DecisionId) => {
    if (nodeExists.has(id)) selectedNodes.add(id);
  };

  const direction = dirDefault(query);

  // -------------------------
  // Query handlers
  // -------------------------
  if (query.kind === "NEIGHBORS") {
    addNodeOnly(query.node_id);

    const outs = out.get(query.node_id) ?? [];
    const ins = inn.get(query.node_id) ?? [];

    if (direction === "DOWN" || direction === "BOTH") {
      for (const e of outs) addEdge(e);
    }
    if (direction === "UP" || direction === "BOTH") {
      for (const e of ins) addEdge(e);
    }

    return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById, {
      explanation: `Neighbors for ${query.node_id} (${direction})`,
    });
  }

  if (query.kind === "LINEAGE") {
    const depth = clamp(query.depth ?? 5, 1, 10_000);
    const dir = query.direction ?? "UP";

    addNodeOnly(query.node_id);

    // BFS by depth
    let frontier = new Set<DecisionId>([query.node_id]);
    for (let d = 0; d < depth; d++) {
      const next = new Set<DecisionId>();
      for (const n of frontier) {
        const edges = dir === "UP" ? (inn.get(n) ?? []) : (out.get(n) ?? []);
        for (const e of edges) {
          addEdge(e);
          next.add(dir === "UP" ? e.from_decision_id : e.to_decision_id);
          if (selectedEdges.size + selectedNodes.size >= limit) break;
        }
        if (selectedEdges.size + selectedNodes.size >= limit) break;
      }
      frontier = next;
      if (frontier.size === 0) break;
      if (selectedEdges.size + selectedNodes.size >= limit) break;
    }

    return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById, {
      explanation: `Lineage ${dir} from ${query.node_id} depth=${depth}`,
    });
  }

  if (query.kind === "PATH") {
    // BFS shortest path in directed graph both directions? We'll do directed BOTH by exploring out+in.
    const allowed = edgeTypes;
    const start = query.from;
    const goal = query.to;

    addNodeOnly(start);
    addNodeOnly(goal);

    const parent = new Map<DecisionId, { prev: DecisionId; edge_id: string }>();
    const q: DecisionId[] = [start];
    const seen = new Set<DecisionId>([start]);

    while (q.length > 0 && (selectedEdges.size + selectedNodes.size) < limit) {
      const cur = q.shift()!;
      if (cur === goal) break;

      const outs = out.get(cur) ?? [];
      for (const e of outs) {
        scannedEdgesCounter.n++;
        if (!edgeAllowed(e, allowed)) continue;
        const nxt = e.to_decision_id;
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        parent.set(nxt, { prev: cur, edge_id: e.edge_id });
        q.push(nxt);
      }
    }

    if (!parent.has(goal) && start !== goal) {
      return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById, {
        explanation: `No path found from ${start} to ${goal}`,
      });
    }

    // Reconstruct path
    let cur = goal;
    while (cur !== start) {
      const p = parent.get(cur);
      if (!p) break;
      const e = edgeById.get(p.edge_id);
      if (e) addEdge(e);
      cur = p.prev;
      if (selectedEdges.size + selectedNodes.size >= limit) break;
    }

    return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById, {
      explanation: `Shortest path from ${start} to ${goal}`,
    });
  }

  if (query.kind === "SUBGRAPH") {
    const depth = clamp(query.depth ?? 2, 0, 10_000);
    const seeds = query.node_ids ?? [];

    for (const s of seeds) addNodeOnly(s);

    // Expand both directions depth times
    let frontier = new Set<DecisionId>(seeds);
    for (let d = 0; d < depth; d++) {
      const next = new Set<DecisionId>();
      for (const n of frontier) {
        for (const e of out.get(n) ?? []) {
          addEdge(e);
          next.add(e.to_decision_id);
          if (selectedEdges.size + selectedNodes.size >= limit) break;
        }
        for (const e of inn.get(n) ?? []) {
          addEdge(e);
          next.add(e.from_decision_id);
          if (selectedEdges.size + selectedNodes.size >= limit) break;
        }
        if (selectedEdges.size + selectedNodes.size >= limit) break;
      }
      frontier = next;
      if (frontier.size === 0) break;
      if (selectedEdges.size + selectedNodes.size >= limit) break;
    }

    return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById, {
      explanation: `Subgraph around ${seeds.length} seeds depth=${depth}`,
    });
  }

  // Exhaustive guard
  return finalizeResult(focus, snapshot, selectedNodes, selectedEdges, scannedEdgesCounter.n, limit, edgeById);
}

function defaultLimit(q: DagQuery): number {
  if (q.kind === "NEIGHBORS") return 250;
  if (q.kind === "LINEAGE") return 2000;
  if (q.kind === "PATH") return 2000;
  if (q.kind === "SUBGRAPH") return 5000;
  return 2000;
}

function finalizeResult(
  focus: DecisionId,
  snapshot: DagSnapshot,
  nodes: Set<DecisionId>,
  edges: Set<string>,
  scannedEdges: number,
  limit: number,
  edgeById: Map<string, ProvenanceEdge>,
  extra?: { explanation?: string }
): DagQueryResult {
  // Ensure focus is included if present in snapshot
  nodes.add(focus);

  // Clip to limit deterministically
  const allNodes = sortNodesDeterministic(snapshot.nodes)
    .map((n) => n.decision_id)
    .filter((id) => nodes.has(id));

  const allEdges = sortEdgesDeterministic(snapshot.edges)
    .map((e) => e.edge_id)
    .filter((id) => edges.has(id));

  const clippedNodes = allNodes.slice(0, limit);
  const clippedEdgeIds = allEdges.slice(0, Math.max(0, limit - clippedNodes.length));

  // Also ensure nodes implied by edges are included (best effort)
  for (const eid of clippedEdgeIds) {
    const e = edgeById.get(eid);
    if (!e) continue;
    if (!clippedNodes.includes(e.from_decision_id)) clippedNodes.push(e.from_decision_id);
    if (!clippedNodes.includes(e.to_decision_id)) clippedNodes.push(e.to_decision_id);
    if (clippedNodes.length >= limit) break;
  }

  return {
    focus,
    nodes: clippedNodes,
    edges: clippedEdgeIds,
    stats: {
      returned_nodes: clippedNodes.length,
      returned_edges: clippedEdgeIds.length,
      scanned_edges: scannedEdges,
    },
    explanation: extra?.explanation,
  };
}

