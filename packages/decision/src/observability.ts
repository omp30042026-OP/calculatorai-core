import type { Decision } from "./decision";
import { getProvenanceBag } from "./provenance";

export function getDecisionSummary(d: Decision) {
  const exec = (d as any)?.artifacts?.execution ?? (d as any)?.artifacts?.extra?.execution ?? null;

  const violations = Array.isArray(exec?.violations) ? exec.violations : [];
  const openBlock = violations.filter((v: any) => v?.severity === "BLOCK" && !v?.resolved_at);

  const obligations = Array.isArray(exec?.obligations) ? exec.obligations : [];
  const openObl = obligations.filter((o: any) => (o?.status ?? "OPEN") === "OPEN");

  const bag = getProvenanceBag(d as any);
  const last = bag.nodes?.length ? bag.nodes[bag.nodes.length - 1] : null;

  return {
    decision_id: (d as any).decision_id,
    state: (d as any).state,
    updated_at: (d as any).updated_at ?? null,

    open_block_violations: openBlock.length,
    open_obligations: openObl.length,
    last_evaluated_at: exec?.last_evaluated_at ?? null,

    risk: (d as any).risk ?? null,

    provenance_tail: last
      ? { seq: last.seq, event_type: last.event_type, node_id: last.node_id, node_hash: last.node_hash }
      : null,
  };
}

