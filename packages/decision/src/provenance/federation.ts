// packages/decision/src/provenance/federation.ts
import crypto from "crypto";
import type { DagSnapshot } from "./dag.js";
import { sortEdgesDeterministic, sortNodesDeterministic } from "./dag.js";
import { computeGraphHash } from "./graph-hash.js";
type DecisionId = string;
/**
 * A portable, signed, tenant-scoped DAG snapshot.
 * The "bundle" is what crosses org boundaries.
 *
 * IMPORTANT:
 * - contains only snapshot data (nodes/edges) + hash
 * - can be signed separately via veritascale seal/sign on the JSON
 */
export type FederationBundleV1 = {
  kind: "VERITASCALE_FEDERATION_BUNDLE_V1";
  tenant_id: string; // org/tenant namespace
  issuer_org_id: string; // who created this bundle
  issued_at: string; // ISO timestamp
  focus: DecisionId;
  snapshot: DagSnapshot;

  // Deterministic identity of the graph content
  graph_hash: string;

  // Optional: allow consumers to re-check expected root lineage anchor
  root_id?: string;

  // Future extension
  meta?: Record<string, unknown>;
};

function isoNow(): string {
  return new Date().toISOString();
}

export function createFederationBundle(params: {
  tenant_id: string;
  issuer_org_id: string;
  snapshot: DagSnapshot;
  root_id?: string;
  issued_at?: string;
  meta?: Record<string, unknown>;
}): FederationBundleV1 {
  const nodes = sortNodesDeterministic(params.snapshot.nodes);
  const edges = sortEdgesDeterministic(params.snapshot.edges);

  const snapshot: DagSnapshot = {
    focus: params.snapshot.focus,
    nodes,
    edges,
  };

  const graph_hash = computeGraphHash(snapshot);

  return {
    kind: "VERITASCALE_FEDERATION_BUNDLE_V1",
    tenant_id: params.tenant_id,
    issuer_org_id: params.issuer_org_id,
    issued_at: params.issued_at ?? isoNow(),
    focus: snapshot.focus,
    snapshot,
    graph_hash,
    root_id: params.root_id,
    meta: params.meta,
  };
}

/**
 * Headless verify:
 * - structure sanity
 * - recompute graph_hash matches
 */
export function verifyFederationBundle(bundle: FederationBundleV1): {
  ok: boolean;
  reason?: string;
} {
  if (!bundle || bundle.kind !== "VERITASCALE_FEDERATION_BUNDLE_V1") return { ok: false, reason: "bad_kind" };
  if (!bundle.tenant_id) return { ok: false, reason: "missing_tenant_id" };
  if (!bundle.issuer_org_id) return { ok: false, reason: "missing_issuer_org_id" };
  if (!bundle.issued_at) return { ok: false, reason: "missing_issued_at" };
  if (!bundle.snapshot) return { ok: false, reason: "missing_snapshot" };
  if (!bundle.graph_hash) return { ok: false, reason: "missing_graph_hash" };

  const recomputed = computeGraphHash({
    focus: bundle.snapshot.focus,
    nodes: sortNodesDeterministic(bundle.snapshot.nodes),
    edges: sortEdgesDeterministic(bundle.snapshot.edges),
  });

  if (recomputed !== bundle.graph_hash) return { ok: false, reason: "graph_hash_mismatch" };

  return { ok: true };
}

/**
 * Optional helper if you want a quick "bundle id" without signing:
 * deterministic hash of header + graph_hash (not a signature).
 */
export function computeBundleId(bundle: FederationBundleV1): string {
  const payload = JSON.stringify({
    kind: bundle.kind,
    tenant_id: bundle.tenant_id,
    issuer_org_id: bundle.issuer_org_id,
    issued_at: bundle.issued_at,
    focus: bundle.focus,
    graph_hash: bundle.graph_hash,
    root_id: bundle.root_id ?? null,
  });

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}
