// packages/decision/src/decision-dag.ts
import crypto from "node:crypto";
import type { DecisionStore, DecisionEdgeRecord } from "./store.js";

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

export type DagNode = {
  decision_id: string;
  node_hash: string; // deterministic hash of node payload
};

export type DagPayload = {
  kind: "DECISION_DAG_V1";
  decision_id: string;
  direction: "UPSTREAM" | "DOWNSTREAM" | "BOTH";
  nodes: DagNode[];
  edges: DecisionEdgeRecord[];
  dag_hash: string; // hash of {nodes,edges}
};

export async function buildDecisionDagPayload(params: {
  store: DecisionStore;
  decision_id: string;
  direction: "UPSTREAM" | "DOWNSTREAM" | "BOTH";
  max_depth?: number; // default 10
}): Promise<{ ok: true; payload: DagPayload } | { ok: false; error: string }> {
  const { store, decision_id } = params;
  const maxDepth = Math.max(1, Math.floor(params.max_depth ?? 10));

  if (!store.listDecisionEdges) {
    return { ok: false, error: "Store does not implement listDecisionEdges()." };
  }

  const dir = params.direction;

  const nodes = new Set<string>();
  const edges: DecisionEdgeRecord[] = [];

  nodes.add(decision_id);

  // BFS layers
  let frontier = new Set<string>([decision_id]);

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.size === 0) break;

    const next = new Set<string>();

    for (const cur of frontier) {
      const wantDirs: Array<"UPSTREAM" | "DOWNSTREAM"> =
        dir === "BOTH" ? ["UPSTREAM", "DOWNSTREAM"] : [dir];

      for (const d of wantDirs) {
        const hop = await store.listDecisionEdges(cur, d);

        for (const e of hop) {
          edges.push(e);

          const neighbor = d === "UPSTREAM" ? e.to_decision_id : e.from_decision_id;
          if (!nodes.has(neighbor)) {
            nodes.add(neighbor);
            next.add(neighbor);
          }
        }
      }
    }

    frontier = next;
  }

  // Build nodes with a deterministic node_hash.
  // (Minimal canonical node payload: {decision_id}. You can enrich later with public hashes/snapshots.)
  const nodeList: DagNode[] = Array.from(nodes)
    .sort()
    .map((id) => ({
      decision_id: id,
      node_hash: sha256Hex(stableStringify({ kind: "DAG_NODE_V1", decision_id: id })),
    }));

  // Sort edges deterministically
  const edgeList = edges
    .slice()
    .sort((a, b) => {
      const ak = `${a.from_decision_id}|${a.to_decision_id}|${a.relation}|${a.via_event_seq}|${a.edge_hash}`;
      const bk = `${b.from_decision_id}|${b.to_decision_id}|${b.relation}|${b.via_event_seq}|${b.edge_hash}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });

  const dag_hash = sha256Hex(
    stableStringify({
      kind: "DECISION_DAG_V1",
      decision_id,
      direction: dir,
      nodes: nodeList,
      edges: edgeList,
    })
  );

  const payload: DagPayload = {
    kind: "DECISION_DAG_V1",
    decision_id,
    direction: dir,
    nodes: nodeList,
    edges: edgeList,
    dag_hash,
  };

  return { ok: true, payload };
}

// -----------------------------
// One-click answers
// -----------------------------
export async function oneClickAnswers(params: {
  store: DecisionStore;
  decision_id: string;
  max_depth?: number;
}): Promise<
  | { ok: true; derived: boolean; summary_how: string; roots: string[] }
  | { ok: false; error: string }
> {
  const { store, decision_id } = params;

  if (!store.listDecisionEdges) {
    return { ok: false, error: "Store does not implement listDecisionEdges()." };
  }

  // Derived vs independent = do we have ANY upstream edges?
  const upstream = await store.listDecisionEdges(decision_id, "UPSTREAM");
  const derived = upstream.length > 0;

  // “How did we end up here?” = walk upstream breadth-first, collect “root” decisions
  const maxDepth = Math.max(1, Math.floor(params.max_depth ?? 10));
  const seen = new Set<string>([decision_id]);
  let frontier = new Set<string>([decision_id]);
  const roots: string[] = [];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.size === 0) break;

    const next = new Set<string>();
    let progressed = false;

    for (const cur of frontier) {
      const hops = await store.listDecisionEdges(cur, "UPSTREAM");
      if (hops.length === 0) {
        // no upstream => root-ish
        if (cur !== decision_id) roots.push(cur);
        continue;
      }

      for (const e of hops) {
        progressed = true;
        const parent = e.to_decision_id;
        if (!seen.has(parent)) {
          seen.add(parent);
          next.add(parent);
        }
      }
    }

    if (!progressed) break;
    frontier = next;
  }

  const uniqRoots = Array.from(new Set(roots)).sort();

  const summary_how = derived
    ? `This decision has upstream links (derived). Found ${upstream.length} immediate upstream edge(s). Root candidates (multi-hop) within depth=${maxDepth}: ${uniqRoots.length ? uniqRoots.join(", ") : "(none found)"}.`
    : `This decision has no upstream links (independent) in decision_edges.`;

  return { ok: true, derived, summary_how, roots: uniqRoots };
}
