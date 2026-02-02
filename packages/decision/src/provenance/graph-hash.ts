// packages/decision/src/provenance/graph-hash.ts
// Feature 10.2: Graph Hashing + Hash-Chaining for the Provenance DAG
//
// Goals:
// - Deterministic, reproducible "graph_hash" for a DagSnapshot
// - Optional chain: prev_graph_hash -> graph_hash (tamper-evident lineage stream)
// - Works without leaking raw evidence: edges can carry reason_hash only
//
// Depends on:
// - packages/decision/src/provenance/dag.ts (canonicalizeSnapshot)
//
// NOTE:
// - We deliberately avoid Node's JSON key-order pitfalls by canonicalizing arrays
//   and by using a stable stringify that sorts object keys recursively.

import { createHash, randomUUID } from "node:crypto";
import type { DagSnapshot, ProvenanceEdge } from "./dag.js";
import { canonicalizeSnapshot } from "./dag.js";

export type Sha256Hex = string;

export type GraphHashHeaderV1 = {
  kind: "VERITASCALE_DAG_HASH_V1";
  alg: "sha256";
  created_at: string;

  // The decision this graph is centered on (usually "current decision")
  focus: string;

  // Optional chain: previous graph hash (e.g., previous commit / previous snapshot)
  prev_graph_hash?: Sha256Hex;

  // The computed hash of the canonical snapshot (header excluded)
  graph_hash: Sha256Hex;

  // Optional: the edge_id that produced this snapshot in an append-only journal
  // (useful when snapshots are emitted per edge append)
  anchor_edge_id?: string;
};

// -------------------------
// Public API
// -------------------------

/**
 * Compute the deterministic graph hash for a snapshot.
 * - canonicalizes nodes/edges order
 * - stable-stringifies the canonical snapshot
 * - hashes the bytes with sha256
 *
 * This hash does NOT include prev_graph_hash. (That belongs to the chain header.)
 */
export function computeGraphHash(snapshot: DagSnapshot): Sha256Hex {
  const canon = canonicalizeSnapshot(snapshot);
  const payload = stableStringify({
    focus: canon.focus,
    nodes: canon.nodes,
    edges: canon.edges,
  });

  return sha256Hex(payload);
}

/**
 * Compute a chained graph hash header.
 * The chain hash is just the hash of:
 *   stableStringify({ prev_graph_hash, graph_hash, focus, anchor_edge_id, created_at, kind, alg })
 *
 * But we keep the "graph_hash" as the primary content hash, and allow chain validation
 * by hashing the header itself if/when you want (later feature).
 *
 * For now: header.graph_hash is the content hash; prev_graph_hash links snapshots.
 */
export function makeGraphHashHeader(params: {
  snapshot: DagSnapshot;
  created_at: string;
  prev_graph_hash?: Sha256Hex;
  anchor_edge_id?: string;
}): GraphHashHeaderV1 {
  const graph_hash = computeGraphHash(params.snapshot);

  const header: GraphHashHeaderV1 = {
    kind: "VERITASCALE_DAG_HASH_V1",
    alg: "sha256",
    created_at: params.created_at,
    focus: params.snapshot.focus,
    prev_graph_hash: params.prev_graph_hash,
    graph_hash,
    anchor_edge_id: params.anchor_edge_id,
  };

  // Clean undefined fields for stable serialization / nicer output
  return stripUndefined(header);
}

/**
 * Verify that a snapshot matches a given graph_hash.
 */
export function verifyGraphHash(snapshot: DagSnapshot, expected: Sha256Hex): {
  ok: boolean;
  computed: Sha256Hex;
  reason?: string;
} {
  const computed = computeGraphHash(snapshot);
  if (computed !== expected) {
    return { ok: false, computed, reason: "graph_hash_mismatch" };
  }
  return { ok: true, computed };
}

/**
 * Optional utility: create a deterministic edge id if caller didn't supply one.
 * Good for "append edge" APIs.
 */
export function newEdgeId(prefix = "edge"): string {
  // uuid keeps collisions basically impossible; prefix makes logs readable.
  return `${prefix}_${randomUUID()}`;
}

/**
 * Optional utility: compute a reason_hash from any arbitrary object/string.
 * Use this to reference evidence without embedding it.
 */
export function computeReasonHash(input: unknown): Sha256Hex {
  const s =
    typeof input === "string"
      ? input
      : stableStringify(input === undefined ? null : input);
  return sha256Hex(s);
}

/**
 * Optional utility: ensure edges have reason_hash (never raw reason content).
 * If you pass in reason data, you get reason_hash out.
 */
export function edgeWithReasonHash<E extends Omit<ProvenanceEdge, "reason_hash"> & { reason?: unknown }>(
  edge: E
): ProvenanceEdge {
  const { reason, ...rest } = edge as any;
  const out: ProvenanceEdge = {
    ...(rest as ProvenanceEdge),
    reason_hash: reason === undefined ? undefined : computeReasonHash(reason),
  };
  return stripUndefined(out);
}

// -------------------------
// Internals
// -------------------------

function sha256Hex(input: string | Buffer): Sha256Hex {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable stringify:
 * - recursively sorts object keys
 * - preserves array order (we already canonicalize arrays in dag.ts)
 * - avoids undefined (JSON drops it); we normalize undefined -> null
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value: any): any {
  if (value === undefined) return null;
  if (value === null) return null;

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;

  // Date objects -> ISO string
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) return value.map(stableNormalize);

  if (t === "object") {
    const keys = Object.keys(value).sort();
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = stableNormalize(value[k]);
    return out;
  }

  // functions/symbols/bigint -> string representation (shouldn't happen in JSON)
  return String(value);
}

function stripUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

