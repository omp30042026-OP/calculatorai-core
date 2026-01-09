// examples/run-decision-approval-gates.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 5;
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow();
  const opts: DecisionEngineOptions = { now };

  // -----------------------------
  // FAIL FLOW (should be blocked)
  // -----------------------------
  const failId = "dec_gates_fail_001";

  const fail_validate = await applyEventWithStore(
    store,
    {
      decision_id: failId,
      metaIfCreate: { title: "Approval Gates – Fail", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      block_on_consequence_block: true,
    },
    opts
  );

  // ❌ No SIMULATE first + actor_roles not manager => consequence preview contains BLOCK
  // ✅ We enable block_on_consequence_block so this MUST return ok:false with CONSEQUENCE_BLOCKED
  const fail_approve = await applyEventWithStore(
    store,
    {
      decision_id: failId,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        meta: { actor_roles: ["cashier"] },
      } as any,
      block_on_consequence_block: true, // ✅ IMPORTANT: make it actually block
    },
    opts
  );

  // -----------------------------
  // PASS FLOW (should succeed)
  // -----------------------------
  const okId = "dec_gates_ok_001";

  const ok_validate = await applyEventWithStore(
    store,
    {
      decision_id: okId,
      metaIfCreate: { title: "Approval Gates – OK", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      block_on_consequence_block: true,
    },
    opts
  );

  const ok_simulate = await applyEventWithStore(
    store,
    {
      decision_id: okId,
      event: { type: "SIMULATE", actor_id: "alice" },
      block_on_consequence_block: true,
    },
    opts
  );

  const ok_approve = await applyEventWithStore(
    store,
    {
      decision_id: okId,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        meta: { actor_roles: ["manager"] },
      } as any,
      block_on_consequence_block: true,
    },
    opts
  );

  process.stdout.write(
    JSON.stringify(
      {
        fail_flow: { validate: fail_validate, approve: fail_approve },
        pass_flow: { validate: ok_validate, simulate: ok_simulate, approve: ok_approve },
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



