// examples/run-decision-signer-binding.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import crypto from "node:crypto";

// IMPORTANT: make now() constant for signer-binding demo
// so replayed decision timestamps don’t drift and change hashes.
function makeStableNow(iso = "2025-01-01T00:00:00.000Z") {
  return () => iso;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: any): any => {
    if (v === null) return null;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      const vv = v[k];
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeStableNow();
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_signer_bind_001";

  // 1) VALIDATE
  const validate = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Signer Binding Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
    },
    opts
  );

  if (!validate.ok) throw new Error("validate failed");

  // Compute the state_hash of the current head we intend to sign
  const head = await store.getDecision(decision_id);
  if (!head) throw new Error("missing decision");

  const correct_state_hash = computeStateHash(head);
  const wrong_state_hash = "00" + correct_state_hash.slice(2);

  // 2) APPROVE with WRONG binding -> should BLOCK
  const approve_bad = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        meta: {
          signer_id: "alice",
          signer_state_hash: wrong_state_hash,
        },
      } as any,
      idempotency_key: "a_bad",
      require_signer_identity_binding: true,
    },
    opts
  );

  // 3) APPROVE with CORRECT binding -> should PASS
  const approve_ok = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        meta: {
          signer_id: "alice",
          signer_state_hash: correct_state_hash,
        },
      } as any,
      idempotency_key: "a_ok",
      require_signer_identity_binding: true,
    },
    opts
  );

  process.stdout.write(
    JSON.stringify(
      {
        validate,
        approve_bad,
        approve_ok,
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


