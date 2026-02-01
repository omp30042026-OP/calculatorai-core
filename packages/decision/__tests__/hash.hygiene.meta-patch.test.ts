import { describe, it, expect } from "vitest";
import { computePublicStateHash, computeTamperStateHash } from "../src/state-hash.js";

describe("hash hygiene: meta *_patch fields do not affect hashes", () => {
  it("ignores meta patch/helper keys", () => {
    const base: any = {
      decision_id: "hygiene1",
      created_at: "2026-01-31T00:00:00Z",
      meta: {},
      risk: {},
      artifacts: {},
    };

    const patched: any = {
      ...base,
      meta: {
        attribution_patch: { source: "AI", system_id: "veritascale", model: "gpt" },
        responsibility_graph_patch: { actors: [], edges: [] },
        some_new_future_patch: { x: 1 }, // ensures the generic rule works
      },
    };

    expect(computePublicStateHash(patched)).toBe(computePublicStateHash(base));
    expect(computeTamperStateHash(patched)).toBe(computeTamperStateHash(base));
  });
});

