import { describe, it, expect } from "vitest";
import { SqliteDecisionStore } from "../src/sqlite-store";
import { applyEventWithStore } from "../src/store-engine";

describe("liability idempotency", () => {
  it("does not duplicate receipts on same idempotency key", async () => {
    const store = new SqliteDecisionStore(":memory:");

    const input = {
      decision_id: "dec_test_1",
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "user_1",
        actor_type: "human",
        artifacts: [{ kind: "doc", uri: "file://x" }],
      } as any,
      idempotency_key: "idem-001",
    };

    const opts = { now: () => "2026-01-27T00:00:00.000Z" };

    const r1 = await applyEventWithStore(store as any, input as any, opts as any);
    const r2 = await applyEventWithStore(store as any, input as any, opts as any);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const db = (store as any).db;
    const events = db.prepare(`SELECT count(*) as c FROM decision_events WHERE decision_id=?`).get("dec_test_1");
    const receipts = db.prepare(`SELECT count(*) as c FROM liability_receipts WHERE decision_id=?`).get("dec_test_1");

    expect(Number(events.c)).toBe(1);
    expect(Number(receipts.c)).toBe(1);
  });
});