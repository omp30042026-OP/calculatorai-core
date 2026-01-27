import { describe, it, expect } from "vitest";
import { SqliteDecisionStore } from "../src/sqlite-store";
import { applyEventWithStore } from "../src/store-engine";

describe("liability receipts smoke", () => {
  it("creates liability_receipts + hashes", async () => {
    const store = new SqliteDecisionStore(":memory:");

    const r = await applyEventWithStore(
      store as any,
      {
        decision_id: "dec_test_1",
        event: {
          type: "ATTACH_ARTIFACTS",
          actor_id: "user_1",
          actor_type: "human",
          artifacts: [{ kind: "doc", uri: "file://x" }],
        } as any,
        idempotency_key: "idem-001",
      },
      { now: () => "2026-01-27T00:00:00.000Z" }
    );

    expect(r.ok).toBe(true);

    const db = (store as any).db;
    const rows = db
      .prepare(
        `SELECT decision_id,event_seq,receipt_hash,state_after_hash,public_state_after_hash
         FROM liability_receipts WHERE decision_id=?`
      )
      .all("dec_test_1");

    expect(rows.length).toBe(1);
    expect(String(rows[0].receipt_hash || "")).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rows[0].state_after_hash || "")).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rows[0].public_state_after_hash || "")).toMatch(/^[a-f0-9]{64}$/);
  });
});
