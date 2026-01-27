// packages/decision/src/provenance-graph.ts
import type { HexHash } from "./snapshots.js";

export type ProvenanceNode = {
  node_id: string;
  seq: number;
  at: string;
  decision_id: string;

  event_type: string;
  actor_id: string;

  event_hash: HexHash;

  prev_node_id: string | null;
  prev_node_hash: HexHash | null;

  state_before_hash: HexHash;
  state_after_hash: HexHash;

  meta?: any;
  node_hash: HexHash;
};

export type ProvenanceGraph = {
  nodes: Map<string, ProvenanceNode>;
  childrenById: Map<string, string[]>;
  parentsById: Map<string, string[]>;
  head_id: string | null;
};

function pickProvenance(decision: any): any | null {
  return decision?.artifacts?.provenance ?? decision?.artifacts?.extra?.provenance ?? null;
}

function ensureArray<T>(x: any): T[] {
  return Array.isArray(x) ? x : [];
}

export function buildProvenanceGraphFromDecision(decision: unknown): ProvenanceGraph {
  const d: any = decision as any;
  const prov = pickProvenance(d);

  const nodesArr = ensureArray<ProvenanceNode>(prov?.nodes);
  const nodes = new Map<string, ProvenanceNode>();

  for (const n of nodesArr) {
    if (n && typeof n.node_id === "string") nodes.set(n.node_id, n);
  }

  const parentsById = new Map<string, string[]>();
  const childrenById = new Map<string, string[]>();

  const addEdge = (parent: string, child: string) => {
    const p = parentsById.get(child) ?? [];
    if (!p.includes(parent)) p.push(parent);
    parentsById.set(child, p);

    const c = childrenById.get(parent) ?? [];
    if (!c.includes(child)) c.push(child);
    childrenById.set(parent, c);
  };

  // today your structure is a linked-list (prev_node_id),
  // but we store it as DAG-ready arrays.
  for (const n of nodes.values()) {
    const parent = n.prev_node_id;
    if (parent && nodes.has(parent)) addEdge(parent, n.node_id);
  }

  const head_id: string | null =
    (typeof prov?.last_node_id === "string" && nodes.has(prov.last_node_id))
      ? prov.last_node_id
      : guessHead(nodes, childrenById);

  return { nodes, parentsById, childrenById, head_id };
}

function guessHead(nodes: Map<string, ProvenanceNode>, childrenById: Map<string, string[]>): string | null {
  // head = a node that is not a parent of anyone (has no children)
  // in a chain, that's the latest node.
  for (const id of nodes.keys()) {
    const children = childrenById.get(id);
    if (!children || children.length === 0) {
      // there might be multiple heads in forks; pick highest seq
      // so do it properly:
    }
  }
  let best: ProvenanceNode | null = null;
  for (const n of nodes.values()) {
    const children = childrenById.get(n.node_id);
    if (!children || children.length === 0) {
      if (!best || n.seq > best.seq) best = n;
    }
  }
  return best?.node_id ?? null;
}

// ----------- Core Queries ------------

export function getLineage(graph: ProvenanceGraph, fromNodeId?: string | null): ProvenanceNode[] {
  const start = fromNodeId ?? graph.head_id;
  if (!start) return [];
  const out: ProvenanceNode[] = [];

  let curId: string | null = start;
  const seen = new Set<string>();

  // "lineage" in your model is “walk backwards via prev_node_id”
  while (curId) {
    if (seen.has(curId)) break;
    seen.add(curId);

    const n = graph.nodes.get(curId);
    if (!n) break;

    out.push(n);
    curId = n.prev_node_id ?? null;
  }

  return out; // head -> ... -> root
}

export function getRoot(graph: ProvenanceGraph, fromNodeId?: string | null): ProvenanceNode | null {
  const lineage = getLineage(graph, fromNodeId);
  const last = lineage.at(-1);
  return last ?? null;
}

export function getChildren(graph: ProvenanceGraph, nodeId: string): ProvenanceNode[] {
  const kids = graph.childrenById.get(nodeId) ?? [];
  return kids.map((id) => graph.nodes.get(id)).filter(Boolean) as ProvenanceNode[];
}

export function getParents(graph: ProvenanceGraph, nodeId: string): ProvenanceNode[] {
  const ps = graph.parentsById.get(nodeId) ?? [];
  return ps.map((id) => graph.nodes.get(id)).filter(Boolean) as ProvenanceNode[];
}

// ----------- Integrity (graph-level) ------------

export type ProvenanceVerifyResult =
  | { ok: true }
  | { ok: false; code: string; message: string; details?: any };

export function verifyProvenanceLinks(graph: ProvenanceGraph): ProvenanceVerifyResult {
  for (const n of graph.nodes.values()) {
    if (!n.prev_node_id) {
      // root node: must not have prev_node_hash
      if (n.prev_node_hash) {
        return {
          ok: false,
          code: "PROV_ROOT_HAS_PREV_HASH",
          message: "Root provenance node has prev_node_hash but no prev_node_id.",
          details: { node_id: n.node_id },
        };
      }
      continue;
    }

    const parent = graph.nodes.get(n.prev_node_id);
    if (!parent) {
      return {
        ok: false,
        code: "PROV_MISSING_PARENT",
        message: "Provenance node references prev_node_id that does not exist in graph.",
        details: { node_id: n.node_id, prev_node_id: n.prev_node_id },
      };
    }

    // cryptographic link check (fast + high value)
    if (n.prev_node_hash && parent.node_hash !== n.prev_node_hash) {
      return {
        ok: false,
        code: "PROV_PREV_HASH_MISMATCH",
        message: "Provenance prev_node_hash does not match parent node_hash.",
        details: { node_id: n.node_id, expected: parent.node_hash, got: n.prev_node_hash },
      };
    }

    // optional sanity: seq should increase by 1 in the chain
    if (typeof parent.seq === "number" && typeof n.seq === "number" && n.seq !== parent.seq + 1) {
      return {
        ok: false,
        code: "PROV_SEQ_NOT_CONTIGUOUS",
        message: "Provenance seq is not contiguous between node and parent. (Forks later may relax this.)",
        details: { node_id: n.node_id, parent_seq: parent.seq, node_seq: n.seq },
      };
    }
  }

  return { ok: true };
}

