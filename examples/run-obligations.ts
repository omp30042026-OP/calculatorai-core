// examples/run-obligations.ts
import fs from "node:fs";
import path from "node:path";

import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store";
import { applyEventWithStore } from "../packages/decision/src/store-engine";

type Amount = { value: number; currency?: string };

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

function getArtifactsAmount(d: any) {
  return d?.artifacts?.extra?.amount ?? (d?.artifacts as any)?.amount ?? null;
}

function parseArgs(argv: string[]) {
  const out: { dbPath: string; reset: boolean } = { dbPath: "replay-demo.db", reset: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        out.dbPath = next;
        i++;
      }
    }
    if (a === "--reset") out.reset = true;
  }

  return out;
}

async function safeApply(store: SqliteDecisionStore, input: any, now: () => string, label: string) {
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

/**
 * RBAC helper (demo):
 * FSM rejects ASSIGN_ROLE in many states, but engine reads decision_roles.
 */
function upsertRole(
  store: SqliteDecisionStore,
  decision_id: string,
  actor_id: string,
  role: string,
  created_at: string
) {
  const db: any = (store as any).db;
  db.prepare(`
    INSERT OR REPLACE INTO decision_roles(decision_id, actor_id, role, created_at)
    VALUES (?, ?, ?, ?)
  `).run(decision_id, actor_id, role, created_at);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const absDb = path.resolve(process.cwd(), args.dbPath);

  if (args.reset) {
    try {
      fs.unlinkSync(absDb);
      console.log(`🧹 reset: removed ${absDb}`);
    } catch {
      console.log(`🧹 reset: nothing to remove at ${absDb}`);
    }
  }

  console.log(`🗃️  using sqlite db: ${absDb}`);
  const store = new SqliteDecisionStore(absDb);
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z", 250);

  const decision_id = "dec_exec_001";
  const amount: Amount = { value: 2500, currency: "USD" };

  // 1) VALIDATE (creates decision)
  await safeApply(
    store,
    {
      decision_id,
      metaIfCreate: {
        title: "Execution Guarantees Demo",
        owner_id: "system",
        source: "demo",
      },
      event: { type: "VALIDATE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "v1",
    },
    now,
    "VALIDATE"
  );

  let d: any = await store.getDecision(decision_id);
  console.log("\n--- after VALIDATE ---");
  console.log(JSON.stringify({ state: d?.state, execution: getExecution(d) }, null, 2));

  // 2) RBAC: make alice approver (bypass event FSM; engine checks decision_roles)
  upsertRole(store, decision_id, "alice", "approver", now());
  console.log("✅ RBAC: inserted role approver for alice");

  // 3) Attach artifacts — and (after engine change) this will also set canonical amount + fields.amount
  await safeApply(
    store,
    {
      decision_id,
      event: {
        type: "ATTACH_ARTIFACTS",
        actor_id: "system",
        actor_type: "system",
        artifacts: {
          extra: {
            amount: { value: amount.value, currency: amount.currency },
            note: "artifact amount (debug)",
          },
        },
      },
      idempotency_key: "amt_art_1",
    },
    now,
    "ATTACH_ARTIFACTS (amount via artifacts.extra.amount)"
  );

  // 4) Add breached obligation
  await safeApply(
    store,
    {
      decision_id,
      event: {
        type: "ADD_OBLIGATION",
        actor_id: "alice",
        actor_type: "human",
        obligation: {
          obligation_id: "obl_sla_001",
          title: "Upload rollout evidence within SLA",
          description: "Demo SLA: must fulfill quickly",
          owner_id: "alice",
          due_at: "2025-01-01T00:00:03.500Z",
          grace_seconds: 0,
          severity: "BLOCK",
          tags: { demo: "true" },
        },
      },
      idempotency_key: "obl1",
    },
    now,
    "ADD_OBLIGATION"
  );

  d = await store.getDecision(decision_id);
  console.log("\n--- after ADD_OBLIGATION ---");
  console.log(
    JSON.stringify(
      {
        state: d?.state,
        amount: (d as any)?.amount,
        fields_amount: (d as any)?.fields?.amount,
        artifacts_amount: getArtifactsAmount(d),
        execution: getExecution(d),
      },
      null,
      2
    )
  );

  // 5) SIMULATE confirm breach
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "sim1",
    },
    now,
    "SIMULATE (confirm breach)"
  );

  // 6) APPROVE while breached (should block EXECUTION, not hash mismatch)
  console.log("\n🧪 TRY APPROVE WHILE BREACHED (should BLOCK: EXECUTION_BLOCKED)");
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "approve1",
    },
    now,
    "APPROVE (while breached)"
  );

  // 7) Fulfill obligation
  await safeApply(
    store,
    {
      decision_id,
      event: {
        type: "FULFILL_OBLIGATION",
        actor_id: "alice",
        actor_type: "human",
        obligation_id: "obl_sla_001",
        proof: { type: "LINK", ref: "https://example.com/evidence", meta: { demo: true } },
      },
      idempotency_key: "ful1",
    },
    now,
    "FULFILL_OBLIGATION"
  );

  // 8) SIMULATE after fulfill
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "SIMULATE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "sim2",
    },
    now,
    "SIMULATE (after fulfill)"
  );

  // 9) APPROVE after fulfill should pass (no hash mismatch)
  console.log("\n🧪 TRY APPROVE AFTER FULFILL (should PASS)");
  await safeApply(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "alice", actor_type: "human" },
      idempotency_key: "approve2",
    },
    now,
    "APPROVE (after fulfill)"
  );

  d = await store.getDecision(decision_id);
  console.log("\n✅ FINAL DECISION SNAPSHOT");
  console.log(
    JSON.stringify(
      {
        state: d?.state,
        amount: (d as any)?.amount,
        fields_amount: (d as any)?.fields?.amount,
        artifacts_amount: getArtifactsAmount(d),
        execution: getExecution(d),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

