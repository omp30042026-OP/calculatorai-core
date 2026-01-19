// examples/run-obligations.ts
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store";
import { applyEventWithStore } from "../packages/decision/src/store-engine";

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z", stepMs = 250) {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

function getExecution(decision: any) {
  return decision?.artifacts?.execution ?? decision?.artifacts?.extra?.execution ?? null;
}

function getProvenance(d: any) {
  const a = d?.artifacts ?? {};
  const extra = a?.extra ?? {};
  return a?.provenance ?? extra?.provenance ?? null;
}


async function safeApply(
  store: SqliteDecisionStore,
  input: any,
  now: () => string,
  label: string
) {
  const r: any = await applyEventWithStore(store as any, input as any, { now });

  if (r?.ok) {
    console.log(`✅ ${label}: applied`);
    return r;
  }

  console.log(`🛑 ${label}: blocked/failed`);
  if (Array.isArray(r?.violations) && r.violations.length) {
    console.log(JSON.stringify(r.violations, null, 2));
  } else if (r?.error) {
    console.log(String(r.error?.message ?? r.error));
  } else {
    console.log(JSON.stringify(r, null, 2));
  }
  return r;
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z", 250);

  const decision_id = "dec_exec_001";

  // 1) Create + VALIDATE
  await safeApply(
    store,
    {
      decision_id,
      metaIfCreate: {
        title: "Execution Guarantees Demo",
        owner_id: "system",
        source: "demo",
      },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
    },
    now,
    "VALIDATE"
  );

  // Show baseline
  let d = await store.getDecision(decision_id);
  console.log("\n--- after VALIDATE ---");
  console.log(
    JSON.stringify(
        { state: d?.state, execution: getExecution(d), provenance: getProvenance(d) },
        null,
        2
    )
  );

  // 2) ADD_OBLIGATION (due very soon)
  const obligation_id = "obl_sla_001";

  const due_at = now(); // soon (and we keep ticking time)
  now(); // tick once more so "now" advances beyond due_at for later evaluation

  await safeApply(
    store,
    {
      decision_id,
      event: {
        type: "ADD_OBLIGATION",
        actor_id: "alice",
        obligation_id,
        title: "Upload rollout evidence within SLA",
        description: "Demo SLA: must fulfill quickly",
        owner_id: "alice",
        due_at,
        grace_seconds: 0,
        severity: "BLOCK",
        tags: { demo: "true" },
      },
      idempotency_key: "o_add_1",
    },
    now,
    "ADD_OBLIGATION"
  );

  d = await store.getDecision(decision_id);
  console.log("\n--- after ADD_OBLIGATION ---");
  console.log(
    JSON.stringify(
        { state: d?.state, execution: getExecution(d), provenance: getProvenance(d) },
        null,
        2
    )
    );

  // 3) SIMULATE to trigger evaluator -> should mark breach + create BLOCK violation
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "alice" },
      idempotency_key: "s_blocked",
    },
    now,
    "SIMULATE (should mark breach)"
  );

  d = await store.getDecision(decision_id);
  console.log("\n--- after SIMULATE (breach check) ---");
  console.log(
    JSON.stringify(
        { state: d?.state, execution: getExecution(d), provenance: getProvenance(d) },
        null,
        2
     )
    );

  // 4) TRY APPROVE while breached -> should BLOCK
  console.log("\n🧪 TRY APPROVE WHILE BREACHED (should BLOCK)");
  const rApprove = await safeApply(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "alice", reason: "should be blocked due to SLA breach" },
      idempotency_key: "approve_blocked_1",
    },
    now,
    "APPROVE"
  );

  console.log(rApprove.ok ? "❌ APPROVE: unexpectedly applied" : "✅ APPROVE: blocked as expected");

  // 5) FULFILL_OBLIGATION
  await safeApply(
    store,
    {
      decision_id,
      event: {
        type: "FULFILL_OBLIGATION",
        actor_id: "alice",
        obligation_id: "obl_sla_001",
        proof: {
          type: "LINK",
          ref: "https://example.com/evidence",
          payload_hash: null,
          meta: { demo: true },
        },
      },
      idempotency_key: "o_fulfill_1",
    },
    now,
    "FULFILL_OBLIGATION"
  );

  d = await store.getDecision(decision_id);
  console.log("\n--- after FULFILL_OBLIGATION ---");
  console.log(
    JSON.stringify(
        { state: d?.state, execution: getExecution(d), provenance: getProvenance(d) },
        null,
        2
    )
  );

  // 6) SIMULATE should pass and stay unblocked
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "alice" },
      idempotency_key: "s_ok",
    },
    now,
    "SIMULATE (should PASS after fulfill)"
  );

  d = await store.getDecision(decision_id);
  console.log("\n✅ FINAL DECISION SNAPSHOT");
  console.log(
    JSON.stringify(
        { state: d?.state, execution: getExecution(d), provenance: getProvenance(d) },
        null,
        2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

