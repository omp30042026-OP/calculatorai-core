// examples/run-decision-legal-constraints.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import type { CompliancePolicy } from "../packages/decision/src/compliance-constraints.js";

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

  const decision_id = "dec_legal_001";

  const compliancePolicy: CompliancePolicy = {
    enabled: true,
    rules: [
      // Example: REJECT must include a reason in meta.reason
      {
        type: "REQUIRE_EVENT_META_KEYS",
        event_types: ["REJECT"],
        keys: ["reason"],
        code: "LEGAL_REJECT_REQUIRES_REASON",
        message: "Legal: REJECT must include a reason in meta.reason.",
        severity: "BLOCK",
      },

      // Example: APPROVE must include ticket_id + policy_ack
      {
        type: "REQUIRE_EVENT_META_KEYS",
        event_types: ["APPROVE"],
        keys: ["ticket_id", "policy_ack"],
        code: "LEGAL_APPROVE_REQUIRES_EVIDENCE",
        message: "Legal: APPROVE requires meta.ticket_id and meta.policy_ack.",
        severity: "BLOCK",
      },

      // Example: for some orgs, DISALLOW DELETE-like operations
      {
        type: "DISALLOW_EVENT_TYPES",
        event_types: ["DELETE", "PURGE"],
        code: "LEGAL_DELETE_DISALLOWED",
        message: "Legal: destructive events are disallowed.",
        severity: "BLOCK",
      },
    ],
  };

  const validate = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Legal Constraints Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
    },
    opts
  );

  // 1) APPROVE without required meta -> should BLOCK
  const approve_block = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "alice" } as any,
      idempotency_key: "a1",
      compliancePolicy,
      complianceContext: { jurisdiction: "US" },
    },
    opts
  );

  // 2) APPROVE with required meta -> should pass
  const approve_ok = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        meta: { ticket_id: "JIRA-123", policy_ack: true },
      } as any,
      idempotency_key: "a2",
      compliancePolicy,
      complianceContext: { jurisdiction: "US" },
    },
    opts
  );

  process.stdout.write(
    JSON.stringify(
      { validate, approve_block, approve_ok },
      null,
      2
    ) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

