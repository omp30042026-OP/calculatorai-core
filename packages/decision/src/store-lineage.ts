// packages/decision/src/store-lineage.ts
import type { DecisionStore } from "./store.js";

export type ForkEdge = {
  child_decision_id: string;
  parent_decision_id: string;
  parent_seq?: number | null; // if you store it in meta/artifacts later
};

export type ForkLineage = {
  root_decision_id: string;
  nodes: string[]; // decision_ids
  edges: ForkEdge[];
};

function getParentIdFromDecisionMeta(d: any): string | null {
  const meta = d?.meta ?? {};
  // accept a few common keys (keep it flexible)
  return (
    meta.parent_decision_id ??
    meta.parentDecisionId ??
    meta.forked_from_decision_id ??
    meta.forkedFromDecisionId ??
    null
  );
}

/**
 * Builds a simple lineage graph by scanning a list of decision_ids and reading their root decision meta.
 * Works without needing a dedicated forks table.
 */
export async function buildForkLineage(
  store: DecisionStore,
  input: {
    root_decision_id: string;
    candidate_decision_ids: string[]; // include root + any forks you created
  }
): Promise<{ ok: true; lineage: ForkLineage } | { ok: false; error: string }> {
  const { root_decision_id, candidate_decision_ids } = input;

  const nodes = Array.from(new Set(candidate_decision_ids));
  if (!nodes.includes(root_decision_id)) nodes.unshift(root_decision_id);

  const edges: ForkEdge[] = [];

  for (const id of nodes) {
    const root = await store.getRootDecision(id);
    if (!root) continue;

    const parent = getParentIdFromDecisionMeta(root);
    if (parent) {
      edges.push({
        child_decision_id: id,
        parent_decision_id: parent,
        parent_seq: (root as any)?.meta?.parent_seq ?? null,
      });
    }
  }

  // keep only edges that connect within our nodes list
  const nodeSet = new Set(nodes);
  const filtered = edges.filter((e) => nodeSet.has(e.parent_decision_id));

  return {
    ok: true,
    lineage: {
      root_decision_id,
      nodes,
      edges: filtered,
    },
  };
}

