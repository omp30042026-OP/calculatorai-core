import Database from "better-sqlite3";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";

function now() {
  return new Date().toISOString();
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function parseJsonArg(name: string): any | null {
  const v = arg(name);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`Invalid JSON for ${name}: ${v}`);
  }
}

type ApplyResult = {
  ok: boolean;
  decision?: any;
  violations?: Array<{ code: string; message: string; details?: any }>;
};

function mustApply(label: string, res: ApplyResult) {
  if (res?.ok) return res;
  console.error(`\n[${label}] FAILED`);
  console.error(JSON.stringify(res, null, 2));
  throw new Error(`[${label}] failed (see violations above)`);
}

/**
 * policy.ts throws something like:
 * "Cannot VALIDATE: missing required meta fields: a, b, c."
 * We parse out ["a","b","c"] and auto-fill.
 */
function extractMissingMetaFields(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/missing required meta fields:\s*([^.]+)\./i);
  const list = m?.[1];
  if (!list) return [];
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildDefaultValidateMeta(actor_id: string) {
  return {
    title: "Seed decision for PLS test",
    owner_id: actor_id,

    validator_id: actor_id,
    validated_at: now(),
    reason: "seed validate for pls-test",
    ticket: "TEST-0001",
  };
}

function fillMissing(meta: Record<string, any>, missing: string[], actor_id: string) {
  const filled = { ...meta };
  for (const k of missing) {
    if (filled[k] === undefined || filled[k] === null || filled[k] === "") {
      if (k === "title") {
        filled[k] = "Seed decision for PLS test";
      } else if (k === "owner_id") {
        filled[k] = actor_id;
      } else if (k.toLowerCase().includes("at") || k.toLowerCase().includes("time") || k.toLowerCase().includes("date")) {
        filled[k] = now();
      } else if (k.toLowerCase().includes("id") || k.toLowerCase().includes("actor")) {
        filled[k] = actor_id;
      } else if (k.toLowerCase().includes("amount")) {
        filled[k] = 199.99;
      } else if (k.toLowerCase().includes("currency")) {
        filled[k] = "USD";
      } else {
        filled[k] = "seed";
      }
    }
  }
  return filled;
}

function ensureAmountCanonical(
  raw: Database.Database,
  decision_id: string,
  amount: { value: number; currency: string }
) {
  const row = raw
    .prepare(`SELECT decision_json FROM decisions WHERE decision_id=?`)
    .get(decision_id) as { decision_json: string } | undefined;

  if (!row?.decision_json) return;

  const d = JSON.parse(row.decision_json);

  // Hard guarantee both paths exist (common patterns)
  d.fields = d.fields ?? {};
  d.fields.amount = d.fields.amount ?? amount;

  d.amount = d.amount ?? amount;

  raw
    .prepare(`UPDATE decisions SET decision_json=? WHERE decision_id=?`)
    .run(JSON.stringify(d), decision_id);

  console.log("[CANONICAL] Ensured amount in decisions.decision_json (fields.amount + amount)");
}


/**
 * ✅ IMPORTANT: Seed canonical decision meta BEFORE ANY EVENT,
 * otherwise the very first receipt hash is computed without it and you get:
 * DECISION_PUBLIC_HASH_MISMATCH after patching.
 */
function seedDecisionIfMissing(
  raw: Database.Database,
  decision_id: string,
  actor_id: string,
  title: string
) {
  const exists = raw
    .prepare(`SELECT decision_id FROM decisions WHERE decision_id=? LIMIT 1;`)
    .get(decision_id) as { decision_id?: string } | undefined;

  if (exists?.decision_id) return;

  const created = now();

  // Keep this minimal but valid. Engine will evolve it via events.
  const seedDecision = {
    decision_id,
    version: 1,
    state: "DRAFT",
    created_at: created,
    updated_at: created,
    meta: { title, owner_id: actor_id },

      // ✅ seed the amount in canonical decision too (workflow sees it even before events)
      fields: { amount: { value: 199.99, currency: "USD" } },
      amount: { value: 199.99, currency: "USD" },

      artifacts: {},
      risk: {
      owner_id: null,
      severity: null,
      blast_radius: [],
      impacted_systems: [],
      rollback_plan_id: null,
      rollback_owner_id: null,
      notes: null,
      links: [],
    },
    signatures: [],
    history: [],
    accountability: {
      created_by: actor_id,
      last_actor_id: actor_id,
      last_actor_type: "human",
      actor_event_counts: {},
      actor_type_counts: {},
      actor_type_event_counts: {},
    },
  };

  // decisions(root_id NOT NULL) — use decision_id as root_id for seed
  raw
    .prepare(
      `INSERT INTO decisions (decision_id, root_id, version, decision_json)
       VALUES (?, ?, ?, ?);`
    )
    .run(decision_id, decision_id, 1, JSON.stringify(seedDecision));

  console.log(`[CANONICAL] Seeded decisions.decision_json before events (meta.title/meta.owner_id)`);
}

async function applyValidateWithAutoMeta(
  store: any,
  decision_id: string,
  actor_id: string,
  actor_type: string,
  metaFromCli?: any
) {
  let meta: Record<string, any> = {
    ...buildDefaultValidateMeta(actor_id),
    ...(metaFromCli ?? {}),
  };

  if (!meta.title) meta.title = "Seed decision for PLS test";
  if (!meta.owner_id) meta.owner_id = actor_id;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = (await applyEventWithStore(
      store,
      {
        decision_id,
        event: {
          type: "VALIDATE",
          actor_id,
          actor_type,
          meta,
        } as any,
      },
      { now }
    )) as ApplyResult;

    if (res?.ok) return res;

    const fromDetails =
      res?.violations
        ?.filter((v) => v?.code === "MISSING_REQUIRED_FIELDS")
        ?.flatMap((v) => (Array.isArray(v?.details?.missing) ? v.details.missing : [])) ?? [];

    const fromMessage =
      res?.violations
        ?.flatMap((v) => extractMissingMetaFields(v?.message ?? ""))
        ?.filter(Boolean) ?? [];

    const missing = Array.from(new Set([...fromDetails, ...fromMessage]));
    if (missing.length === 0) return res;

    meta = fillMissing(meta, missing, actor_id);
    if (!meta.title) meta.title = "Seed decision for PLS test";
    if (!meta.owner_id) meta.owner_id = actor_id;
  }

  return (await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "VALIDATE",
        actor_id,
        actor_type,
        meta,
      } as any,
    },
    { now }
  )) as ApplyResult;
}

async function main() {
  const dbPath = arg("--db") ?? "replay-demo.db";
  const decision_id = arg("--decision") ?? "dec_exec_001";

  const validateMeta = parseJsonArg("--validateMeta");

  const store = new SqliteDecisionStore(dbPath);
  const raw = new Database(dbPath);

  // ✅ Seed canonical identity BEFORE any event receipts exist
  seedDecisionIfMissing(raw, decision_id, "alice", "Seed decision for PLS test");

  // 1) Seed RBAC so alice can APPROVE
  raw
    .prepare(
      `INSERT OR IGNORE INTO decision_roles (decision_id, actor_id, role, created_at)
       VALUES (?, ?, ?, ?);`
    )
    .run(decision_id, "alice", "approver", now());

  // 2) Ensure workflow step s1_require_amount is satisfied
   const amount = { value: 199.99, currency: "USD" };

    mustApply(
     "ATTACH_ARTIFACTS(amount)",
        (await applyEventWithStore(
        store as any,
        {
            decision_id,
            event: {
                type: "ATTACH_ARTIFACTS",
                actor_id: "alice",
                actor_type: "human",


                // ✅ satisfy workflow that checks decision.fields.amount
                artifacts: { amount },


                // ✅ keep for backwards compatibility (safe if ignored)
                amount,
            } as any,
        },
        { now }
        )) as any
    );
     ensureAmountCanonical(raw, decision_id, amount);


  // 3) VALIDATE
  mustApply(
    "VALIDATE(alice)",
    (await applyValidateWithAutoMeta(store as any, decision_id, "alice", "human", validateMeta)) as any
  );

  // 4) SIMULATE
  mustApply(
    "SIMULATE",
    (await applyEventWithStore(
      store as any,
      {
        decision_id,
        event: { type: "SIMULATE", actor_id: "alice", actor_type: "human" } as any,
      },
      { now }
    )) as any
  );

    // 5) Latest receipt hash AFTER simulate (use as signer_state_hash)
  const lastAfterSim = raw
    .prepare(
      `SELECT state_after_hash
       FROM liability_receipts
       WHERE decision_id=?
       ORDER BY event_seq DESC
       LIMIT 1;`
    )
    .get(decision_id) as { state_after_hash?: string } | undefined;

  if (!lastAfterSim?.state_after_hash) {
    raw.close();
    throw new Error("No liability receipt found; cannot compute signer_state_hash for PLS.");
  }

  const signer_state_hash = String(lastAfterSim.state_after_hash);

  // 6) ✅ APPROVE with PLS required (immediately after simulate)
    // TEMP: do NOT throw, print full blocker JSON
    const approveRes = (await applyEventWithStore(
    store as any,
    {
        decision_id,
        require_liability_shield: true,
        responsibility: { owner_id: "owner_001", owner_role: "manager", org_id: "org_01" },
        approver: { approver_id: "alice", approver_role: "approver" },
        event: {
        type: "APPROVE",
        actor_id: "alice",
        actor_type: "human",
        meta: { signer_state_hash },
        } as any,
    },
    { now }
    )) as any;

    if (!approveRes?.ok) {
    console.error("\n[APPROVE(PLS)] FAILED (non-throw)");
    console.error(JSON.stringify(approveRes, null, 2));
    raw.close();
    process.exit(1);
    }

    // if it succeeded, keep same behavior
    const res = approveRes;

  // 7) Optional: EXPLAIN after approve (for receipt / binding / UI)
  mustApply(
    "EXPLAIN(after approve)",
    (await applyEventWithStore(
      store as any,
      {
        decision_id,
        event: {
          type: "EXPLAIN",
          actor_id: "alice",
          actor_type: "human",
          prompt: "post-approve receipt",
        } as any,
      },
      { now }
    )) as any
  );

  console.log(JSON.stringify(res, null, 2));



  raw.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

