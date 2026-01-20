import { describe, it, expect } from "vitest";
import { createDecisionV2 } from "../src/decision";
import { replayDecision } from "../src/engine";
import { verifyProvenanceChain } from "../src/provenance";

describe("provenance chain integrity", () => {
  it("fails if a middle node is modified (breaks downstream prev_node_hash linkage)", () => {
    const now = () => "2026-01-19T00:00:00.000Z";

    const root = createDecisionV2(
      { decision_id: "dec_prov_chain_001", meta: { title: "Test", owner_id: "u1" }, artifacts: {}, version: 1 } as any,
      now
    ) as any;

    const rr = replayDecision(
      root,
      [
        { type: "VALIDATE", actor_id: "u1", actor_type: "human" } as any,
        { type: "SIMULATE", actor_id: "u1", actor_type: "human" } as any,
        { type: "EXPLAIN", actor_id: "u1", actor_type: "human" } as any,
      ],
      { now }
    );

    if (rr.ok === false) {
      throw new Error("Replay failed unexpectedly: " + JSON.stringify(rr.violations ?? [], null, 2));
    }

    const decision = rr.decision as any;

    // sanity
    expect(verifyProvenanceChain(decision).ok).toBe(true);

    const nodes = decision?.artifacts?.extra?.provenance?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 3) {
      throw new Error("Expected at least 3 provenance nodes");
    }

    // tamper middle node
    nodes[1].event_type = "HACKED_MIDDLE";

    const vr = verifyProvenanceChain(decision);
    expect(vr.ok).toBe(false);
    // often this will be NODE_HASH_MISMATCH at index 1 OR BROKEN_PREV_HASH at index 2
  });
});

