// packages/decision/src/store-fork-graph.ts
import type { Decision } from "./decision.js";
import type { DecisionStore } from "./store.js";

export type ForkGraphNode = {
  decision_id: string;
  title?: string;
  owner_id?: string;
  source?: string;

  parent_decision_id?: string;
  fork_from_seq?: number;
};

export type ForkGraphEdge = {
  from: string; // parent
  to: string;   // child
  fork_from_seq: number;
};

export type ForkGraph = {
  root_decision_id: string;
  nodes: ForkGraphNode[];
  edges: ForkGraphEdge[];
};

function asMeta(d: Decision | null): any {
  return (d as any)?.meta ?? {};
}

function toNode(d: Decision): ForkGraphNode {
  const meta = asMeta(d);
  return {
    decision_id: d.decision_id,
    title: meta.title,
    owner_id: meta.owner_id,
    source: meta.source,
    parent_decision_id:
      (d as any).parent_decision_id ??
      (meta as any)?.parent_decision_id ??
      null,
    fork_from_seq: typeof meta.fork_from_seq === "number" ? meta.fork_from_seq : undefined,
  };
}

/**
 * V7 fork graph builder.
 * You pass candidate_decision_ids (same pattern as lineage).
  * We read each decision's ROOT decision fields (canonical-first):
 * - parent_decision_id (top-level), with meta.parent_decision_id as legacy fallback
 * - fork_from_seq (currently stored in meta)
 */
export async function buildForkGraph(
  store: DecisionStore,
  input: {
    root_decision_id: string;
    candidate_decision_ids: string[];
  }
): Promise<{ ok: true; graph: ForkGraph } | { ok: false; error: string }> {
  const ids = Array.from(new Set(input.candidate_decision_ids));

  // load root decisions for all ids (fork metadata lives on root)
  const roots = await Promise.all(ids.map((id) => store.getRootDecision(id)));
  const decisions: Decision[] = roots.filter(Boolean) as Decision[];

  // Ensure root exists
  if (!decisions.some((d) => d.decision_id === input.root_decision_id)) {
    return { ok: false, error: `Missing root decision: ${input.root_decision_id}` };
  }

  const nodes = decisions.map(toNode);

  const idSet = new Set(nodes.map((n) => n.decision_id));
  const edges: ForkGraphEdge[] = [];

  for (const n of nodes) {
    if (!n.parent_decision_id) continue;
    if (!idSet.has(n.parent_decision_id)) continue; // parent not in candidate set
    if (typeof n.fork_from_seq !== "number") continue; // must be explicit

    edges.push({
      from: n.parent_decision_id,
      to: n.decision_id,
      fork_from_seq: n.fork_from_seq,
    });
  }

  return {
    ok: true,
    graph: {
      root_decision_id: input.root_decision_id,
      nodes,
      edges,
    },
  };
}

