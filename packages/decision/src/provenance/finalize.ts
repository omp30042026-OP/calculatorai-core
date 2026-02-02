// packages/decision/src/provenance/finalize.ts
import { buildDagSnapshot } from "./dag-builder.js";
import { computeGraphHash } from "./graph-hash.js";

/**
 * Finalizes provenance by attaching a deterministic DAG snapshot + graph hash
 * onto the decision object BEFORE sealing/signing.
 *
 * Canonical rule: provenance is written last (canonical-first, at the end).
 */
export type FinalizeProvenanceInput = {
  decision: any;
  history: any[];
};

export type FinalizeProvenanceOutput = {
  decision: any;
  dag_snapshot: any;
  graph_hash: string;
};

export function finalizeProvenance(input: FinalizeProvenanceInput): FinalizeProvenanceOutput {
  const { decision, history } = input;

  // 1) Build deterministic DAG snapshot from decision + history
  const dag_snapshot = buildDagSnapshot({ decision, history });

  // 2) Hash the snapshot deterministically
  const graph_hash = computeGraphHash(dag_snapshot);

  // 3) Attach onto decision (provenance lives on the decision)
  //    Keep it under decision.provenance so it becomes sealed/signed with the decision.
  decision.provenance = decision.provenance ?? {};
  decision.provenance.dag = dag_snapshot;
  decision.provenance.graph_hash = graph_hash;

  return { decision, dag_snapshot, graph_hash };
}

