import { describe, it, expect } from "vitest";
import { createFederationBundle, verifyFederationBundle } from "../src/provenance/federation.js";
import { mergeDagSnapshots } from "../src/provenance/merge.js";
import type { DagSnapshot } from "../src/provenance/dag.js";

describe("provenance: federation + merge", () => {
  it("federation bundle verifies graph_hash", () => {
    const snap: DagSnapshot = {
      focus: "d1",
      nodes: [{ decision_id: "d1", root_id: "r1", version: 1, state_hash: "h1", created_at: "2026-02-01T00:00:00.000Z" }],
      edges: [],
    };
    const b = createFederationBundle({ tenant_id: "t1", issuer_org_id: "orgA", snapshot: snap });
    expect(verifyFederationBundle(b).ok).toBe(true);
  });

  it("merge detects node hash conflict", () => {
    const left: DagSnapshot = {
      focus: "d1",
      nodes: [{ decision_id: "d1", root_id: "r1", version: 1, state_hash: "h_left", created_at: "2026-02-01T00:00:00.000Z" }],
      edges: [],
    };
    const right: DagSnapshot = {
      focus: "d1",
      nodes: [{ decision_id: "d1", root_id: "r1", version: 1, state_hash: "h_right", created_at: "2026-02-01T00:00:00.000Z" }],
      edges: [],
    };

    const m = mergeDagSnapshots({ left, right });
    expect(m.conflicts.length).toBe(1);
    expect(m.conflicts.length).toBe(1);
    expect(m.conflicts[0]?.kind).toBe("NODE_STATE_HASH_MISMATCH");
  });
});

