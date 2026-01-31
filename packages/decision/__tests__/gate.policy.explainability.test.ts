import { describe, it, expect } from "vitest";
import { evaluateEventGate } from "../src/gates/evaluate-event-gate";
import { createMemoryStore } from "./_helpers/memory-store";

describe("Feature 21: gate_report explainability (POLICY)", () => {
  it("returns POLICY gate_report when policy blocks", async () => {
    const store = createMemoryStore();

    const r = await evaluateEventGate({
      decision_id: "gp1",
      decision: { decision_id: "gp1", state: "VALIDATED" },
      event: { type: "APPROVE" },
      store,
      internal_bypass_enterprise_gates: false,
      hooks: {
        evaluatePolicyForEvent: () => ({
          ok: false,
          code: "POLICY_BLOCK_TEST",
          message: "Blocked by test policy",
        }),
      },
    } as any);

    expect(r.ok).toBe(false);
    // If you return gate_report in the result type:
    expect((r as any).gate_report.failed_gate).toBe("POLICY");
    expect((r as any).gate_report.policy.ok).toBe(false);
  });
});
