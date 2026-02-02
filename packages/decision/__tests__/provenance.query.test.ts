import { describe, it, expect } from "vitest";
import { runDagQuery } from "../src/provenance/query-engine.js";
import type { DagSnapshot } from "../src/provenance/dag.js";

describe("provenance: query engine", () => {
  it("neighbors returns expected nodes/edges", () => {
    const snap: DagSnapshot = {
      focus: "d1",
      nodes: [
        { decision_id: "d1", root_id: "r1", version: 1, state_hash: "h1", created_at: "2026-02-01T00:00:00.000Z" },
        { decision_id: "d0", root_id: "r1", version: 1, state_hash: "h0", created_at: "2026-02-01T00:00:00.000Z" },
      ],
      edges: [
        {
          edge_id: "e1",
          from_decision_id: "d0",
          to_decision_id: "d1",
          edge_type: "DERIVED_FROM",
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ],
    };

    const r = runDagQuery(snap, { kind: "NEIGHBORS", node_id: "d1", direction: "UP" });
    expect(r.nodes).toContain("d1");
    expect(r.nodes).toContain("d0");
    expect(r.edges.length).toBe(1);
  });
});

