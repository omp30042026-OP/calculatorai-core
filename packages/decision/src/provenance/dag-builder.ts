// packages/decision/src/provenance/dag-builder.ts
//
// Feature 10.3: DAG Builder
// Takes (decision + history/events) and produces a DagSnapshot.
// - Works with your existing "decision" objects without forcing a strict schema.
// - Uses safe heuristics by default, but allows full customization via callbacks.
// - Does NOT embed raw evidence; you can pass reason objects and we hash them.
//
// Depends on:
// - ./dag.ts (types + canonicalizeSnapshot)
// - ./graph-hash.ts (edge id + reason hashing helpers)

import type { DagSnapshot, ProvenanceEdge } from "./dag.js";

type DagNode = DagSnapshot["nodes"][number];

import { canonicalizeSnapshot } from "./dag.js";
import { edgeWithReasonHash, newEdgeId } from "./graph-hash.js";

const nowIso = () => new Date().toISOString();
import type { EdgeType } from "./dag.js";

const asEdgeType = (x: string) => x as EdgeType;

export type DecisionLike = Record<string, any>;
export type DecisionEventLike = Record<string, any>;

export type BuildDagSnapshotInput = {
  decision: DecisionLike;
  history?: DecisionEventLike[]; // optional event list / journal / timeline
};

export type BuildDagSnapshotOptions = {
  /**
   * If not provided, we'll infer from:
   * - decision.decision_id
   * - decision.id
   * - decision.meta?.decision_id
   */
  getDecisionId?: (decision: DecisionLike) => string;

  /**
   * Optional "root" / "group" id used in many systems.
   * If not provided, we'll infer from:
   * - decision.root_id
   * - decision.meta?.root_id
   * - else fallback to decision_id
   */
  getRootId?: (decision: DecisionLike) => string | undefined;

  /**
   * Optional parent / derived-from id. If present, we create an edge parent -> decision.
   * Heuristics (in order):
   * - decision.parent_decision_id
   * - decision.derived_from_decision_id
   * - decision.forked_from_decision_id
   * - decision.meta?.parent_decision_id
   * - decision.meta?.derived_from_decision_id
   * - decision.meta?.forked_from_decision_id
   */
  getParentId?: (decision: DecisionLike) => string | undefined;

  /**
   * If you have an explicit list of referenced decisions, we can add edges:
   * ref_id -> decision_id (or decision -> ref_id depending on your meaning).
   * Default: reads decision.refs (array of ids) or decision.meta?.refs.
   */
  getRefs?: (decision: DecisionLike) => string[];

  /**
   * How to turn a decision into a DagNode.
   * Default creates a minimal node: { decision_id, root_id?, label?, kind? }
   */
  toNode?: (decision: DecisionLike, ctx: { decision_id: string; root_id?: string }) => DagNode;

  /**
   * Provide additional nodes from history (e.g., approvals, disputes, forks, obligations).
   * Default: none.
   */
  extraNodesFromHistory?: (history: DecisionEventLike[]) => DagNode[];

  /**
   * Map history events to edges. If not provided, we create edges using best-effort heuristics.
   */
  edgesFromHistory?: (history: DecisionEventLike[], focusDecisionId: string) => ProvenanceEdge[];

  /**
   * If true, include a "root" node (root_id) when root_id differs from decision_id.
   * Default: true.
   */
  includeRootNode?: boolean;

  /**
   * If true, include "ref" nodes for refs list.
   * Default: true.
   */
  includeRefNodes?: boolean;
};

export function buildDagSnapshot(
  input: BuildDagSnapshotInput,
  opts: BuildDagSnapshotOptions = {}
): DagSnapshot {
  const includeRootNode = opts.includeRootNode ?? true;
  const includeRefNodes = opts.includeRefNodes ?? true;

  const decision_id = (opts.getDecisionId ?? defaultGetDecisionId)(input.decision);
  const root_id =
    (opts.getRootId ?? defaultGetRootId)(input.decision) ?? decision_id;

  const parent_id = (opts.getParentId ?? defaultGetParentId)(input.decision);
  const refs = (opts.getRefs ?? defaultGetRefs)(input.decision);

  // 1) Nodes
  const nodes: DagNode[] = [];

  // Focus node
  nodes.push(
    (opts.toNode ?? defaultToNode)(input.decision, { decision_id, root_id })
  );

  // Root node (optional)
  if (includeRootNode && root_id && root_id !== decision_id) {
    nodes.push(makeSyntheticNode(root_id, { kind: "ROOT", label: "Root" }));
  }

  // Parent node (if present)
  if (parent_id && parent_id !== decision_id) {
    nodes.push(makeSyntheticNode(parent_id, { kind: "PARENT", label: "Parent" }));
  }

  // Ref nodes (optional)
  if (includeRefNodes) {
    for (const r of refs) {
      if (r && r !== decision_id) {
        nodes.push(makeSyntheticNode(r, { kind: "REF", label: "Referenced" }));
      }
    }
  }

  // Extra nodes from history (optional)
  const history = input.history ?? [];
  const extraNodes = (opts.extraNodesFromHistory ?? defaultExtraNodesFromHistory)(history);
  for (const n of extraNodes) nodes.push(n);

  // 2) Edges
  const edges: ProvenanceEdge[] = [];

  const asEdgeType = (x: string) => x as unknown as import("./dag.js").EdgeType;

  // Parent -> focus edge
  if (parent_id && parent_id !== decision_id) {
    edges.push(
      edgeWithReasonHash({
        edge_id: newEdgeId("edge"),
        from_decision_id: parent_id,
        to_decision_id: decision_id,
        edge_type: "DERIVED_FROM",
        created_at: nowIso(),
        reason: { type: "derived_from", parent_id },
      })
    );
  }

  

  // History edges
  const histEdges = (opts.edgesFromHistory ?? defaultEdgesFromHistory)(history, decision_id);
  for (const e of histEdges) edges.push(e);

  // 3) Assemble + canonicalize
  const snapshot: DagSnapshot = {
    focus: decision_id,
    nodes: dedupeNodes(nodes),
    edges: dedupeEdges(edges),
  };

  return canonicalizeSnapshot(snapshot);
}

// -------------------------
// Defaults / heuristics
// -------------------------

function defaultGetDecisionId(d: DecisionLike): string {
  const v =
    d?.decision_id ??
    d?.id ??
    d?.meta?.decision_id;

  if (typeof v !== "string" || !v.trim()) {
    throw new Error("[dag-builder] Missing decision id (expected decision_id or id).");
  }
  return v;
}

function defaultGetRootId(d: DecisionLike): string | undefined {
  const v = d?.root_id ?? d?.meta?.root_id;
  return typeof v === "string" && v.trim() ? v : undefined;
}

function defaultGetParentId(d: DecisionLike): string | undefined {
  const candidates = [
    d?.parent_decision_id,
    d?.derived_from_decision_id,
    d?.forked_from_decision_id,
    d?.meta?.parent_decision_id,
    d?.meta?.derived_from_decision_id,
    d?.meta?.forked_from_decision_id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return undefined;
}

function defaultGetRefs(d: DecisionLike): string[] {
  const v = d?.refs ?? d?.meta?.refs;
  if (Array.isArray(v)) {
    return v.filter((x) => typeof x === "string" && x.trim());
  }
  return [];
}

function defaultToNode(
  d: DecisionLike,
  ctx: { decision_id: string; root_id?: string }
): DagNode {
  // Keep this super minimal to avoid schema coupling.
  // If your DagNode has stricter fields, adjust here.
  const title =
    typeof d?.meta?.title === "string" ? d.meta.title :
    typeof d?.title === "string" ? d.title :
    undefined;

  return stripUndefined({
    decision_id: ctx.decision_id,
    root_id: ctx.root_id,
    label: title,
    kind: "DECISION",
  }) as unknown as DagNode;
}

function defaultExtraNodesFromHistory(_history: DecisionEventLike[]): DagNode[] {
  return [];
}

/**
 * Heuristic event->edge mapper:
 * If an event has { from_decision_id, to_decision_id }, we create an edge.
 * Otherwise, if it has { decision_id, related_decision_id }, we link related -> decision.
 * Otherwise ignore.
 *
 * We also accept:
 * - event.kind / event.type as edge.kind
 * - event.edge_id if present
 * - event.reason / event.note hashed into reason_hash
 */
function defaultEdgesFromHistory(
  history: DecisionEventLike[],
  focusDecisionId: string
): ProvenanceEdge[] {
  const out: ProvenanceEdge[] = [];

  for (const ev of history) {
    const from =
      (typeof ev?.from_decision_id === "string" && ev.from_decision_id.trim())
        ? ev.from_decision_id
        : (typeof ev?.related_decision_id === "string" && ev.related_decision_id.trim())
        ? ev.related_decision_id
        : undefined;

    const to =
      (typeof ev?.to_decision_id === "string" && ev.to_decision_id.trim())
        ? ev.to_decision_id
        : (typeof ev?.decision_id === "string" && ev.decision_id.trim())
        ? ev.decision_id
        : focusDecisionId;

    if (!from || !to || from === to) continue;

    const kind =
      (typeof ev?.kind === "string" && ev.kind.trim())
        ? ev.kind
        : (typeof ev?.type === "string" && ev.type.trim())
        ? ev.type
        : "HISTORY_EDGE";

    const edge_id =
      (typeof ev?.edge_id === "string" && ev.edge_id.trim())
        ? ev.edge_id
        : newEdgeId("edge");

    out.push(
      edgeWithReasonHash({
        edge_id,
        from_decision_id: from,
        to_decision_id: to,
        edge_type: asEdgeType(kind),
        created_at: nowIso(),
        reason: ev?.reason ?? ev?.note ?? ev,
      })
    );
  }

  return out;
}

// -------------------------
// Helpers
// -------------------------

function makeSyntheticNode(
  decision_id: string,
  meta: { kind: string; label?: string }
): DagNode {
  return stripUndefined({
    decision_id,
    kind: meta.kind,
    label: meta.label,
  }) as unknown as DagNode;
}

function dedupeNodes(nodes: DagNode[]): DagNode[] {
  const seen = new Set<string>();
  const out: DagNode[] = [];
  for (const n of nodes) {
    const id = (n as any)?.decision_id;
    if (typeof id !== "string" || !id.trim()) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(n);
  }
  return out;
}

function dedupeEdges(edges: ProvenanceEdge[]): ProvenanceEdge[] {
  const seen = new Set<string>();
  const out: ProvenanceEdge[] = [];
  for (const e of edges) {
    const id = (e as any)?.edge_id;
    if (typeof id !== "string" || !id.trim()) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
