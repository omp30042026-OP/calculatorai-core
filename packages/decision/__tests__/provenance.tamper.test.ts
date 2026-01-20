import { describe, it, expect } from "vitest";

import { createDecisionV2 } from "../src/decision";
import { replayDecision } from "../src/engine";
import { verifyProvenanceChain } from "../src/provenance";

describe("provenance tamper", () => {
  it("fails verification if a provenance node is modified", () => {
    const now = () => "2026-01-19T00:00:00.000Z";

    const root = createDecisionV2(
      {
        decision_id: "dec_prov_test_001",
        meta: { title: "Test", owner_id: "u1" },
        artifacts: {},
        version: 1,
      } as any,
      now
    ) as any;

    const rr = replayDecision(
      root,
      [
        { type: "VALIDATE", actor_id: "u1", actor_type: "human" } as any,
        { type: "SIMULATE", actor_id: "u1", actor_type: "human" } as any,
      ],
      { now }
    );

    if (rr.ok === false) {
      throw new Error(
        "Replay failed unexpectedly: " + JSON.stringify(rr.violations ?? [], null, 2)
      );
    }

    const decision = rr.decision as any;

    // sanity: chain should be valid before tamper
    const ok0 = verifyProvenanceChain(decision);
    expect(ok0.ok).toBe(true);

    // ---- tamper canonical-first chain ----
    const provCanon = decision?.artifacts?.extra?.provenance;
    const nodesCanon = provCanon?.nodes;

    if (!Array.isArray(nodesCanon) || nodesCanon.length === 0) {
      throw new Error("Expected provenance nodes at artifacts.extra.provenance.nodes");
    }

    // Attack: mutate node content WITHOUT updating its recorded node_hash
    const originalHash = nodesCanon[0].node_hash;
    nodesCanon[0].event_type = "HACKED";
    nodesCanon[0].node_hash = originalHash; // explicitly keep old hash

    // (Optional) also tamper compat mirror if present
    const nodesCompat = decision?.artifacts?.provenance?.nodes;
    if (Array.isArray(nodesCompat) && nodesCompat.length) {
      const originalCompatHash = nodesCompat[0].node_hash;
      nodesCompat[0].event_type = "HACKED";
      nodesCompat[0].node_hash = originalCompatHash;
    }

    const vr = verifyProvenanceChain(decision);
    expect(vr.ok).toBe(false);
  });
});

