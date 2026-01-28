// packages/decision/__tests__/gate.explainability.test.ts
import { describe, it, expect } from "vitest";
import { applyEventWithStore } from "../src/store-engine";
import { createMemoryStore } from "./_helpers/memory-store";

function hasColumn(db: any, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r: any) => r.name === col);
}

function seedDecisionForValidateButMissingAmount(store: any, decision_id: string, actor_id: string) {
  const db: any = store.db;
  const now = new Date().toISOString();

  const cols: Array<{ name: string }> = db.prepare(`PRAGMA table_info(decisions)`).all();
  const colset = new Set(cols.map((c) => c.name));

  // IMPORTANT:
  // - include meta.title + meta.owner_id so VALIDATE can pass
  // - intentionally omit fields.amount so APPROVE triggers WORKFLOW_INCOMPLETE
  const decision_json = JSON.stringify({
    decision_id,
    root_id: decision_id,
    version: 1,
    state: "DRAFT",
    created_at: now,
    updated_at: now,
    meta: { title: "Gate explainability test", owner_id: actor_id },
    fields: {}, // ✅ no amount here on purpose
    artifacts: {},
    risk: {},
    history: [],
    accountability: {},
  });

  const values: Record<string, any> = {
    decision_id,
    root_id: decision_id,
    version: 1,
    state: "DRAFT",
    decision_json,
    created_at: now,
    updated_at: now,
  };

  const keys = Object.keys(values).filter((k) => colset.has(k));
  const placeholders = keys.map(() => "?").join(", ");

  db.prepare(
    `INSERT OR REPLACE INTO decisions (${keys.join(", ")}) VALUES (${placeholders})`
  ).run(...keys.map((k) => values[k]));
}

function grantApproverRole(store: any, decision_id: string, actor_id: string) {
  const db: any = store.db;
  const now = new Date().toISOString();

  // insert both forms just like earlier tests (covers any case-sensitivity)
  db.prepare(
    `INSERT OR IGNORE INTO decision_roles(decision_id, actor_id, role, created_at) VALUES (?, ?, ?, ?)`
  ).run(decision_id, actor_id, "APPROVER", now);

  db.prepare(
    `INSERT OR IGNORE INTO decision_roles(decision_id, actor_id, role, created_at) VALUES (?, ?, ?, ?)`
  ).run(decision_id, actor_id, "approver", now);
}

describe("Feature 20: gate_report explainability", () => {
  it("returns gate_report for WORKFLOW_INCOMPLETE", async () => {
    const store = createMemoryStore();
    const decision_id = "gx1";
    const actor_id = "u1";

    // ✅ seed a decision that can VALIDATE, but has no amount (workflow step s1 fails)
    seedDecisionForValidateButMissingAmount(store as any, decision_id, actor_id);

    // 1) VALIDATE should succeed (workflow requires VALIDATE, so we satisfy s2 here)
    const v = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "VALIDATE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: false,
    } as any);

    expect(v.ok).toBe(true);

    // 2) RBAC must pass so workflow becomes the only blocker
    grantApproverRole(store as any, decision_id, actor_id);

    // 3) APPROVE should fail with WORKFLOW_INCOMPLETE + include gate_report
    const r = await applyEventWithStore(store as any, {
      decision_id,
      event: { type: "APPROVE", actor_id, actor_type: "human" } as any,
      internal_bypass_enterprise_gates: false,
    } as any);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((x: any) => x.code === "WORKFLOW_INCOMPLETE")).toBe(true);

      const gr = (r as any).gate_report;
      expect(!!gr).toBe(true);

      // basic shape checks
      expect(gr.decision_id).toBe(decision_id);
      expect(gr.event_type).toBe("APPROVE");

      // ensure the failure is really workflow (not RBAC)
      expect(gr.failed_gate).toBe("WORKFLOW");
      expect(gr.rbac?.ok).toBe(true);

      // workflow should show amount missing
      expect(gr.workflow?.is_complete).toBe(false);
      expect(gr.workflow?.satisfied_steps?.s1_require_amount).toBe(false);
      expect(gr.workflow?.satisfied_steps?.s2_require_validate).toBe(true);
      expect(gr.workflow?.satisfied_steps?.s3_require_approve_or_reject).toBe(true);
    }
  });
});

