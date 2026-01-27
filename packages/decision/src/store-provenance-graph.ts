// packages/decision/src/store-provenance-graph.ts
import type { DecisionStore, DecisionEdgeRecord, DecisionEdgeDirection } from "./store.js";
import crypto from "node:crypto";

// -----------------------------
// small utils (local, deterministic)
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

function safeParseJson(s: string | null): any | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pickConfidence(edge: DecisionEdgeRecord): number | null {
  const m = safeParseJson(edge.meta_json);
  const c = m?.confidence;
  const n = typeof c === "number" ? c : Number(c);
  return Number.isFinite(n) ? n : null;
}

// -----------------------------
// Types for the 3 features
// -----------------------------
export type DecisionDagNode = {
  decision_id: string;

  // best-effort “node hash”
  // (stable identity for exports; not your canonical state hash)
  node_hash: string;

  // optional: provenance tail if present (useful for “How did we end up here?”)
  provenance_tail_hash: string | null;

  // best-effort state hash (may differ if decision_json includes volatile fields)
  state_hash: string | null;
};

export type DecisionDagGraph = {
  root_decision_id: string;
  nodes: Map<string, DecisionDagNode>;
  edges: DecisionEdgeRecord[];

  // convenience adjacency
  upstreamById: Map<string, DecisionEdgeRecord[]>;   // edges pointing into this node
  downstreamById: Map<string, DecisionEdgeRecord[]>; // edges leaving this node
};

export type DagExportPayloadV1 = {
  kind: "DECISION_DAG_V1";
  root_decision_id: string;
  generated_at: string;

  nodes: Array<DecisionDagNode>;
  edges: Array<DecisionEdgeRecord & { meta: any | null }>;

  // hash of the payload contents (excluding itself)
  graph_hash: string;
};

export type OneClickAnswers = {
  derived_or_independent: "DERIVED" | "INDEPENDENT";
  how_did_we_end_up_here: {
    // a single “best” upstream path (highest confidence, then shortest)
    path_decision_ids: string[];
    explanation: string;
  };
};

// -----------------------------
// Core: fetch edges with BFS
// -----------------------------
async function fetchEdges(
  store: DecisionStore,
  decision_id: string,
  direction: DecisionEdgeDirection
): Promise<DecisionEdgeRecord[]> {
  if (!store.listDecisionEdges) return [];
  return (await store.listDecisionEdges(decision_id, direction)) ?? [];
}

function indexEdges(graph: DecisionDagGraph) {
  const upstreamById = new Map<string, DecisionEdgeRecord[]>();
  const downstreamById = new Map<string, DecisionEdgeRecord[]>();

  const push = (m: Map<string, DecisionEdgeRecord[]>, k: string, e: DecisionEdgeRecord) => {
    const arr = m.get(k) ?? [];
    arr.push(e);
    m.set(k, arr);
  };

  for (const e of graph.edges) {
    // e: from -> to
    push(downstreamById, e.from_decision_id, e);
    push(upstreamById, e.to_decision_id, e);
  }

  graph.upstreamById = upstreamById;
  graph.downstreamById = downstreamById;
}

async function computeNode(store: DecisionStore, decision_id: string): Promise<DecisionDagNode> {
  const d = await store.getDecision(decision_id);

  const prov =
    (d as any)?.artifacts?.provenance ??
    (d as any)?.artifacts?.extra?.provenance ??
    null;

  const provenance_tail_hash =
    prov && typeof prov === "object"
      ? (typeof prov.last_node_hash === "string" ? prov.last_node_hash : null)
      : null;

  // best effort state hash
  const state_hash = d ? sha256Hex(stableStringify(d)) : null;

  // export-friendly node hash (stable + cheap)
  const node_hash = sha256Hex(
    stableStringify({
      kind: "DECISION_DAG_NODE_V1",
      decision_id,
      provenance_tail_hash,
      state_hash,
    })
  );

  return { decision_id, node_hash, provenance_tail_hash, state_hash };
}

// -----------------------------
// ✅ (1) Full provenance graph (decision-to-decision DAG)
// -----------------------------
export async function getFullProvenanceGraph(params: {
  store: DecisionStore;
  decision_id: string;

  // safety limits
  max_depth?: number;   // default 6
  max_nodes?: number;   // default 500
}): Promise<
  | { ok: true; graph: DecisionDagGraph }
  | { ok: false; error: string; details?: any }
> {
  const { store, decision_id } = params;
  const max_depth = Math.max(1, Math.floor(params.max_depth ?? 6));
  const max_nodes = Math.max(10, Math.floor(params.max_nodes ?? 500));

  // must exist
  const root = await store.getDecision(decision_id);
  if (!root) return { ok: false, error: `Decision not found: ${decision_id}` };

  if (!store.listDecisionEdges) {
    return {
      ok: false,
      error: "Store does not implement listDecisionEdges().",
      details: { fix: "Implement DecisionStore.listDecisionEdges in sqlite-store.ts" },
    };
  }

  const nodes = new Map<string, DecisionDagNode>();
  const edges: DecisionEdgeRecord[] = [];

  const seenEdgeHash = new Set<string>();
  const seenNode = new Set<string>();

  // BFS both directions from root
  const q: Array<{ id: string; depth: number }> = [{ id: decision_id, depth: 0 }];
  seenNode.add(decision_id);

  while (q.length) {
    const cur = q.shift()!;
    if (cur.depth > max_depth) continue;

    // expand upstream + downstream
    const ups = await fetchEdges(store, cur.id, "UPSTREAM");
    const downs = await fetchEdges(store, cur.id, "DOWNSTREAM");

    const all = [...ups, ...downs];

    for (const e of all) {
      if (!e?.edge_hash) continue;
      if (seenEdgeHash.has(e.edge_hash)) continue;
      seenEdgeHash.add(e.edge_hash);
      edges.push(e);

      const a = e.from_decision_id;
      const b = e.to_decision_id;

      for (const id of [a, b]) {
        if (!id || seenNode.has(id)) continue;
        seenNode.add(id);

        if (seenNode.size > max_nodes) {
          return {
            ok: false,
            error: `Graph too large (>${max_nodes} nodes). Increase max_nodes or limit depth.`,
            details: { max_nodes, max_depth, current_nodes: seenNode.size },
          };
        }

        q.push({ id, depth: cur.depth + 1 });
      }
    }
  }

  // materialize nodes (best effort)
  for (const id of seenNode) {
    const n = await computeNode(store, id);
    nodes.set(id, n);
  }

  const graph: DecisionDagGraph = {
    root_decision_id: decision_id,
    nodes,
    edges,
    upstreamById: new Map(),
    downstreamById: new Map(),
  };

  indexEdges(graph);

  return { ok: true, graph };
}

// -----------------------------
// ✅ (2) Export graph as a DAG payload (nodes + edges + hashes)
// -----------------------------
export function exportDagPayload(graph: DecisionDagGraph, nowIso = new Date().toISOString()): DagExportPayloadV1 {
  const nodes = Array.from(graph.nodes.values()).sort((a, b) => a.decision_id.localeCompare(b.decision_id));

  const edges = graph.edges
    .map((e) => ({
      ...e,
      meta: safeParseJson(e.meta_json),
    }))
    .sort((a, b) => {
      const k1 = `${a.from_decision_id}|${a.to_decision_id}|${a.relation}|${a.via_event_seq}|${a.edge_hash}`;
      const k2 = `${b.from_decision_id}|${b.to_decision_id}|${b.relation}|${b.via_event_seq}|${b.edge_hash}`;
      return k1.localeCompare(k2);
    });

  const base = {
    kind: "DECISION_DAG_V1" as const,
    root_decision_id: graph.root_decision_id,
    generated_at: nowIso,
    nodes,
    edges,
  };

  const graph_hash = sha256Hex(stableStringify(base));

  return { ...base, graph_hash };
}

// -----------------------------
// ✅ (3) One-click answers
// -----------------------------
function bestUpstreamPath(graph: DecisionDagGraph): string[] {
  const start = graph.root_decision_id;

  // If no upstream edges at all -> independent
  const ups0 = graph.upstreamById.get(start) ?? [];
  if (ups0.length === 0) return [start];

  // Dijkstra-ish: prioritize higher confidence, then fewer hops
  // We'll do a simple greedy walk:
  const path = [start];
  const visited = new Set<string>([start]);

  let cur = start;
  while (true) {
    const ups = (graph.upstreamById.get(cur) ?? []).filter((e) => !visited.has(e.from_decision_id));
    if (ups.length === 0) break;

    ups.sort((a, b) => {
      const ca = pickConfidence(a) ?? -1;
      const cb = pickConfidence(b) ?? -1;
      if (cb !== ca) return cb - ca; // higher confidence first
      return a.via_event_seq - b.via_event_seq; // earlier edge first
    });

    const best = ups[0]!;
    const parent = best.from_decision_id;
    path.push(parent);
    visited.add(parent);
    cur = parent;
  }

  return path;
}

export function oneClickAnswers(graph: DecisionDagGraph): OneClickAnswers {
  const root = graph.root_decision_id;

  const upstreamEdges = graph.upstreamById.get(root) ?? [];

  const derived =
    upstreamEdges.some((e) => String(e.relation) === "DERIVES_FROM") ||
    upstreamEdges.length > 0;

  const path = bestUpstreamPath(graph);

  // explain
  const explanation =
    path.length <= 1
      ? "No upstream links found. This decision appears independent (no recorded derivation edges)."
      : `Followed upstream links from ${root} to ${path[path.length - 1]} (best-effort path).`;

  return {
    derived_or_independent: derived ? "DERIVED" : "INDEPENDENT",
    how_did_we_end_up_here: {
      path_decision_ids: path,
      explanation,
    },
  };
}

// -----------------------------
// Convenience: single call that returns all 3 outputs
// -----------------------------
export async function getDecisionDagBundle(params: {
  store: DecisionStore;
  decision_id: string;
  max_depth?: number;
  max_nodes?: number;
  nowIso?: string;
}): Promise<
  | {
      ok: true;
      graph: DecisionDagGraph;
      export: DagExportPayloadV1;
      answers: OneClickAnswers;
    }
  | { ok: false; error: string; details?: any }
> {
  const r = await getFullProvenanceGraph(params);
  if (!r.ok) return r;

  const exportPayload = exportDagPayload(r.graph, params.nowIso ?? new Date().toISOString());
  const answers = oneClickAnswers(r.graph);

  return { ok: true, graph: r.graph, export: exportPayload, answers };
}

