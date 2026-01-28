// packages/decision/__tests__/rbac.finalize.test.ts
import { describe, it, expect } from "vitest";
import util from "node:util";
import { applyEventWithStore } from "../src/store-engine";
import { createMemoryStore } from "./_helpers/memory-store";

function dump(label: string, obj: any) {
  console.log(label, util.inspect(obj, { depth: null, colors: false, maxArrayLength: 1000 }));
}

function hasColumn(db: any, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r: any) => r.name === col);
}

/**
 * Seed a decision row BEFORE any events are applied.
 * Key point: workflow REQUIRE_FIELD("amount") looks at decision.amount (top-level) first.
 */
function seedDecisionBeforeAnyEvents(store: any, decision_id: string, actor_id: string) {
  const db: any = store.db;
  const now = new Date().toISOString();

  const cols: Array<{ name: string }> = db.prepare(`PRAGMA table_info(decisions)`).all();
  const colset = new Set(cols.map((c) => c.name));

  const decision_json = JSON.stringify({
    decision_id,
    root_id: decision_id,
    version: 1,
    state: "DRAFT",
    created_at: now,
    updated_at: now,

    // ✅ workflow expects REQUIRE_FIELD("amount") -> checks decision.amount (top-level)
    amount: 123,
    total_amount: 123,

    // ✅ VALIDATE policy needs meta.title + meta.owner_id
    meta: { title: "Test Decision", owner_id: actor_id, amount: 123 },

    // keep extra copies too (harmless, helps if resolver ever changes)
    fields: { amount: 123 },

    artifacts: {},
    risk: {},
    history: [],
    accountability: {},
  });

  const values: Record<string, any> = {
    decision_id,
    root_id: decision_id, // schema requires NOT NULL
    version: 1,
    state: "DRAFT",
    decision_json,
    created_at: now,
    updated_at: now,
  };

  const keys = Object.keys(values).filter((k) => colset.has(k));
  const placeholders = keys.map(() => "?").join(", ");

  db.prepare(`INSERT OR REPLACE INTO decisions (${keys.join(", ")}) VALUES (${placeholders})`).run(
    ...keys.map((k) => values[k])
  );
}

function patchDecisionJson(db: any, decision_id: string, patch: (d: any) => any) {
  const row = db.prepare(`SELECT decision_json FROM decisions WHERE decision_id = ?`).get(decision_id);
  if (!row) throw new Error(`Decision not found in DB: ${decision_id}`);

  const d = JSON.parse(row.decision_json);
  const next = patch(d);
  const json = JSON.stringify(next);
  const now = new Date().toISOString();

  const canUpdatedAt = hasColumn(db, "decisions", "updated_at");
  if (canUpdatedAt) {
    db.prepare(`UPDATE decisions SET decision_json = ?, updated_at = ? WHERE decision_id = ?`).run(
      json,
      now,
      decision_id
    );
  } else {
    db.prepare(`UPDATE decisions SET decision_json = ? WHERE decision_id = ?`).run(json, decision_id);
  }
}

async function grantApproverRole(store: any, decision_id: string, actor_id: string) {
  const db: any = store.db;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO decision_roles(decision_id, actor_id, role, created_at) VALUES (?, ?, ?, ?)`
  ).run(decision_id, actor_id, "APPROVER", now);

  db.prepare(
    `INSERT OR IGNORE INTO decision_roles(decision_id, actor_id, role, created_at) VALUES (?, ?, ?, ?)`
  ).run(decision_id, actor_id, "approver", now);
}

describe("Feature 18: Hard RBAC gate for finalize events", () => {
  it("BLOCKS APPROVE if actor has no approver/admin role", async () => {
    const store = createMemoryStore();
    const decision_id = "d1";
    const actor_id = "u1";

    // Seed prereqs so ONLY RBAC blocks
    seedDecisionBeforeAnyEvents(store as any, decision_id, actor_id);

    const r = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "APPROVE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: false,
    } as any);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      // if this fails, dump to see what blocked instead
      if (!r.violations.some((v: any) => v.code === "RBAC_ROLE_REQUIRED")) {
        dump("Unexpected violations (expected RBAC_ROLE_REQUIRED):", r.violations);
      }
      expect(r.violations.some((v: any) => v.code === "RBAC_ROLE_REQUIRED")).toBe(true);
    }
  });

  it("ALLOWS APPROVE when actor has approver role (and workflow satisfied)", async () => {
    const store = createMemoryStore();
    const decision_id = "d2";
    const actor_id = "u2";

    // Seed prereqs BEFORE events (avoids hash mismatch)
    seedDecisionBeforeAnyEvents(store as any, decision_id, actor_id);

    // Required by workflow
    const v = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "VALIDATE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: false,
    } as any);
    if (!v.ok) dump("VALIDATE failed violations:", (v as any).violations);
    expect(v.ok).toBe(true);

    // RBAC role
    await grantApproverRole(store as any, decision_id, actor_id);

    // Should pass now
    const r = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "APPROVE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: false,
    } as any);

    if (!r.ok) {
      dump("APPROVE failed violations:", (r as any).violations);
      // helpful: show workflow details if it's that
      const wf = (r as any).violations?.find((x: any) => x.code === "WORKFLOW_INCOMPLETE");
      if (wf) dump("WORKFLOW_INCOMPLETE details:", wf.details);
    }
    expect(r.ok).toBe(true);
  });

  it("BYPASSES gate when internal_bypass_enterprise_gates=true", async () => {
    const store = createMemoryStore();
    const decision_id = "d3";
    const actor_id = "u3";

    const r0 = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "APPROVE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: true,
    } as any);

    expect(r0.ok).toBe(true);
  });
});

