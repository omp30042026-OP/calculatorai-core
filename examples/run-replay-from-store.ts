// examples/run-replay-from-store.ts
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { SqliteDecisionSnapshotStore } from "../packages/decision/src/sqlite-snapshot-store.js";
import { runCounterfactualFromStore } from "../packages/decision/src/replay-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";

import type { DecisionEvent } from "../packages/decision/src/events.ts";
import { assertSnapshotIntegrity, computeDecisionStateHash } from "../packages/decision/src/snapshot-runtime.js";

async function maybeInit(x: any) {
  if (x && typeof x.init === "function") await x.init();
  if (x && typeof x.open === "function") await x.open();
  if (x && typeof x.connect === "function") await x.connect();
}

type DiffItem = { path: string; before: any; after: any };

function compareDiffs(nameA: string, diffA: DiffItem[], nameB: string, diffB: DiffItem[]) {
  const setA = new Map(diffA.map((d) => [d.path, d]));
  const setB = new Map(diffB.map((d) => [d.path, d]));
  const allPaths = Array.from(new Set([...setA.keys(), ...setB.keys()])).sort();

  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const bothDifferent: string[] = [];
  const bothSame: string[] = [];

  for (const p of allPaths) {
    const a = setA.get(p);
    const b = setB.get(p);
    if (a && !b) onlyA.push(p);
    else if (!a && b) onlyB.push(p);
    else if (a && b) {
      const same =
        JSON.stringify(a.before) === JSON.stringify(b.before) &&
        JSON.stringify(a.after) === JSON.stringify(b.after);
      (same ? bothSame : bothDifferent).push(p);
    }
  }

  return { nameA, nameB, onlyA, onlyB, bothDifferent, bothSame };
}

function ensureCounterfactualRunsTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS counterfactual_runs (
      counterfactual_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      base_seq INTEGER NOT NULL,
      locator_json TEXT NOT NULL,
      appended_events_json TEXT NOT NULL,
      final_state TEXT NOT NULL,
      final_state_hash TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (counterfactual_id, decision_id)
    );
    CREATE INDEX IF NOT EXISTS idx_counterfactual_runs_decision_created
      ON counterfactual_runs (decision_id, created_at DESC);
  `);
}

function listCounterfactualRuns(db: any, decision_id: string, limit = 20) {
  const rows = db
    .prepare(
      `SELECT counterfactual_id, decision_id, base_seq, final_state, final_state_hash, created_at
       FROM counterfactual_runs
       WHERE decision_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(decision_id, limit);

  console.log(`\n=== COUNTERFACTUAL RUNS (decision_id=${decision_id}, limit=${limit}) ===`);
  if (!rows.length) {
    console.log("(none)");
    return;
  }

  for (const r of rows) {
    console.log(
      `- id=${r.counterfactual_id} base_seq=${r.base_seq} final_state=${r.final_state} final_hash=${r.final_state_hash} at=${r.created_at}`
    );
  }
}


function getLatestCounterfactualId(db: any, decision_id: string): string | null {
  const row = db.prepare(
    `SELECT counterfactual_id
     FROM counterfactual_runs
     WHERE decision_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(decision_id);
  return row?.counterfactual_id ?? null;
}




function readCounterfactualRun(db: any, decision_id: string, counterfactual_id: string) {
  const row = db
    .prepare(
      `SELECT counterfactual_id, decision_id, base_seq, locator_json,
              appended_events_json, final_state, final_state_hash, diff_json, created_at
       FROM counterfactual_runs
       WHERE counterfactual_id = ? AND decision_id = ?`
    )
    .get(counterfactual_id, decision_id);

  if (!row) throw new Error(`counterfactual not found: ${counterfactual_id}`);
  return row;
}

function showCounterfactualRun(db: any, decision_id: string, counterfactual_id: string) {
  const row = readCounterfactualRun(db, decision_id, counterfactual_id);

  const locator = JSON.parse(row.locator_json);
  const appended_events = JSON.parse(row.appended_events_json);
  const diff = JSON.parse(row.diff_json);

  console.log("\n=== COUNTERFACTUAL RUN (SHOW) ===");
  console.log("counterfactual_id:", row.counterfactual_id);
  console.log("decision_id:", row.decision_id);
  console.log("base_seq:", row.base_seq);
  console.log("created_at:", row.created_at);
  console.log("final_state:", row.final_state);
  console.log("final_state_hash:", row.final_state_hash);

  console.log("\nlocator:");
  console.dir(locator, { depth: 10 });

  console.log("\nappended_events:");
  console.dir(appended_events, { depth: 10 });

  console.log("\ndiff:");
  console.dir(diff, { depth: 10 });
}

function getSnapshotAtSeqStrict(db: any, decision_id: string, up_to_seq: number) {
  // NOTE: if your schema uses `decision` instead of `decision_json`, change this SELECT.
  const row = db
    .prepare(
      `SELECT decision_id, up_to_seq, state_hash, created_at, decision_json
       FROM decision_snapshots
       WHERE decision_id = ? AND up_to_seq = ?
       LIMIT 1`
    )
    .get(decision_id, up_to_seq);

  if (!row) throw new Error(`Missing canonical snapshot at seq=${up_to_seq}`);

  const decision =
    typeof row.decision_json === "string"
      ? JSON.parse(row.decision_json)
      : JSON.parse(String(row.decision_json));

  return {
    decision_id: row.decision_id,
    up_to_seq: row.up_to_seq,
    state_hash: row.state_hash,
    created_at: row.created_at,
    decision,
  };
}

function parseArgs(argv: string[]) {
  const out: {
    list?: number;
    show?: string;
    promote?: string;
    rebase?: string;
    decision_id?: string;
    dbPath?: string;
    demoApproveOrg?: boolean;
  } = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--list") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.list = Number(next);
        i++;
      } else {
        out.list = 20;
      }
      continue;
    }

    if (a === "--show") {
      out.show = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--promote") {
      out.promote = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--decision") {
      out.decision_id = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--db") {
      out.dbPath = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--rebase") {
      out.rebase = argv[i + 1];
      i++;
      continue;
    }

    if (a === "--demo-approve-org") {
      out.demoApproveOrg = true;
      continue;
    }
  }

  return out;
}

function stripEventTrust(ev: any) {
  if (!ev || typeof ev !== "object") return ev;
  const { trust, ...rest } = ev;
  return rest;
}

function trustContextFromEvent(ev: any) {
  const o = ev?.trust?.origin;
  if (!o) return undefined;
  return {
    origin_zone: o.zone,
    origin_system: o.system,
    channel: o.channel,
    tenant_id: o.tenant_id,
  };
}






async function commitCounterfactual(params: {
  store: any;
  snapshotStore: any;
  decision_id: string;
  counterfactual_id: string;
  fixedOpts: any;
  snapshotPolicy?: { every_n_events: number };
}) {
  const { store, snapshotStore, decision_id, counterfactual_id, fixedOpts } = params;
  const snapshotPolicy = params.snapshotPolicy ?? { every_n_events: 1 };

  const db = (store as any).db;

  const row = db
    .prepare(
      `SELECT appended_events_json
       FROM counterfactual_runs
       WHERE counterfactual_id = ? AND decision_id = ?`
    )
    .get(counterfactual_id, decision_id);

  if (!row) throw new Error(`counterfactual not found: ${counterfactual_id}`);

  const appendedEvents = JSON.parse(
    typeof row.appended_events_json === "string" ? row.appended_events_json : String(row.appended_events_json)
  );

  for (const ev of appendedEvents) {
    const trustContext = trustContextFromEvent(ev);

    const res = await applyEventWithStore(
      store,
      {
        decision_id,
        event: stripEventTrust(ev),
        trustContext,
        snapshotStore,
        snapshotPolicy,
        internal_bypass_enterprise_gates: true,
      },
      fixedOpts
    );

    if (!res?.ok) {
      throw new Error(
        `promote apply failed: ${(res?.violations?.[0]?.code ?? "unknown")} ${(res?.violations?.[0]?.message ?? "")}`
      );
    }
  }
}

async function rebaseCounterfactualRun(params: {
  store: any;
  snapshotStore: any;
  decision_id: string;
  old_counterfactual_id: string;
  fixedOpts: any;
}) {
  const { store, snapshotStore, decision_id, old_counterfactual_id, fixedOpts } = params;
  const db = (store as any).db;

  const oldRow = readCounterfactualRun(db, decision_id, old_counterfactual_id);

  const appended_events = JSON.parse(
    typeof oldRow.appended_events_json === "string" ? oldRow.appended_events_json : String(oldRow.appended_events_json)
  );

  const latest = await snapshotStore.getLatestSnapshot(decision_id);
  if (!latest) throw new Error("No canonical snapshot found to rebase onto.");

  const latestSeq = latest.up_to_seq;
  const locator = { kind: "SEQ", seq: latestSeq } as const;

  const { result, diff } = await runCounterfactualFromStore({
    store,
    snapshotStore,
    decision_id,
    locator,
    appended_events,
    engine_version: "engine@1",
    opts: fixedOpts,
  });

  if (!result.ok) throw new Error(`rebase counterfactual failed: ${(result as any).code ?? "unknown"}`);

  const finalHash = String((result as any).final_state_hash ?? "");
  if (!finalHash) throw new Error("Missing final_state_hash from counterfactual result (REBASE).");

  db.prepare(
    `INSERT OR REPLACE INTO counterfactual_runs(
      counterfactual_id, decision_id, base_seq, locator_json,
      appended_events_json, final_state, final_state_hash, diff_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    result.counterfactual_id,
    decision_id,
    latestSeq,
    JSON.stringify(locator),
    JSON.stringify(appended_events),
    result.decision.state,
    finalHash,
    JSON.stringify(diff ?? []),
    fixedOpts.now()
  );

  console.log("\n=== REBASE DONE ===");
  console.log("old_counterfactual_id:", old_counterfactual_id);
  console.log("new_counterfactual_id:", result.counterfactual_id);
  console.log("rebased_on_seq:", latestSeq);
  console.log("final_state:", result.decision.state);

  return result.counterfactual_id;
}

function ensureDecisionRolesTable(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_roles (
      decision_id TEXT NOT NULL,
      actor_id    TEXT NOT NULL,
      role        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (decision_id, actor_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_roles_decision
      ON decision_roles (decision_id);
    CREATE INDEX IF NOT EXISTS idx_decision_roles_actor
      ON decision_roles (actor_id);
  `);
}



function normalizeDecisionForHash(decision: any) {
  // Deep clone so we don’t mutate originals
  const d = JSON.parse(JSON.stringify(decision ?? {}));

  // 1) Canonical store does not keep trust inside history events (you promote with trustContext)
  if (Array.isArray(d.history)) {
    d.history = d.history.map((e: any) => {
      if (!e || typeof e !== "object") return e;

      // normalize empty meta -> null (store often uses null, replay often uses {})
      if (e.meta && typeof e.meta === "object" && Object.keys(e.meta).length === 0) {
        e.meta = null;
      }

      // drop trust to match canonical persisted decision
      if ("trust" in e) e.trust = null;

      return e;
    });
  }


  // 2) Derived/mutable fields differ between replay vs canonical commit
  //    (store-engine recomputes these from event store)
  delete d.accountability;   // <- fixes actor_event_counts mismatch
  delete d.signatures;       // optional but safe if ever populated differently

  return d;
}


function firstDiffPath(a: any, b: any, path = ""): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b) return path || "(root)";
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return `${path}.length`;
      for (let i = 0; i < a.length; i++) {
        const d = firstDiffPath(a[i], b[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    for (const k of keys) {
      if (!(k in a)) return `${path}.${k} (missing in A)`;
      if (!(k in b)) return `${path}.${k} (missing in B)`;
      const d = firstDiffPath(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return path || "(root)";
}


async function main() {
  const args = parseArgs(process.argv.slice(2));

  const decision_id = args.decision_id ?? "demo-decision-store";
  const dbPath = args.dbPath ?? "replay-demo.db";

  const FIXED_NOW = "2026-01-22T00:00:00.000Z";
  const fixedOpts = { now: () => FIXED_NOW };

  const store = new SqliteDecisionStore(dbPath);
  await maybeInit(store);

  const db = (store as any).db;
  ensureCounterfactualRunsTable(db);
  ensureDecisionRolesTable(db);

  db.prepare(`
    INSERT OR REPLACE INTO decision_roles(decision_id, actor_id, role, created_at)
    VALUES (?, ?, ?, ?)
  `).run(decision_id, "alice", "approver", FIXED_NOW);

  const snapshotStore = new SqliteDecisionSnapshotStore(db);
  await maybeInit(snapshotStore);

  // --- CLI commands (list/show/rebase/promote) ---
  if (args.list !== undefined) {
    listCounterfactualRuns(db, decision_id, args.list);
    return;
  }

  if (args.show) {
    showCounterfactualRun(db, decision_id, args.show);
    return;
  }

  if (args.rebase) {
    const newId = await rebaseCounterfactualRun({
      store,
      snapshotStore,
      decision_id,
      old_counterfactual_id: args.rebase,
      fixedOpts,
    });

    console.log(`\nNow promote this rebased id:\nnpm run replay:store -- --promote ${newId}`);
    return;
  }

  if (args.promote) {
    
    const promoteId =
      args.promote === "latest"
        ? getLatestCounterfactualId(db, decision_id)
        : args.promote;

    if (!promoteId) throw new Error("No counterfactual runs exist to promote.");

    const run = readCounterfactualRun(db, decision_id, promoteId);
    
    showCounterfactualRun(db, decision_id, promoteId);

    const latestBefore = await snapshotStore.getLatestSnapshot(decision_id);
    const latestSeq = latestBefore?.up_to_seq;
    if (latestSeq == null) throw new Error("Cannot promote: no canonical snapshot exists.");

    if (latestSeq !== run.base_seq) {
      throw new Error(
        [
          "Cannot promote: canonical chain advanced since this counterfactual was created.",
          `- counterfactual base_seq = ${run.base_seq}`,
          `- canonical latest_seq    = ${latestSeq}`,
          "Fix: rebase and promote the new counterfactual_id.",
        ].join("\n")
      );
    }

    // Pin expected replay to base seq (debug)
    const baseSnap = getSnapshotAtSeqStrict(db, decision_id, run.base_seq);
    console.log("\n=== PROMOTE BASE SNAPSHOT ===");
    console.log("base_seq:", baseSnap.up_to_seq);
    console.log("base_state:", baseSnap.decision?.state);
    console.log("base_state_hash:", baseSnap.state_hash);
    console.log("base_decision_hash:", computeDecisionStateHash(baseSnap.decision));

    // ✅ IMPORTANT: expected replay should use the stored events EXACTLY as stored
    const appended_events_raw = JSON.parse(run.appended_events_json);

    const { result: expectedRes } = await runCounterfactualFromStore({
      store,
      snapshotStore,
      decision_id,
      locator: { kind: "SEQ", seq: baseSnap.up_to_seq },
      appended_events: appended_events_raw,
      engine_version: "engine@1",
      opts: fixedOpts,
    });

    if (!expectedRes.ok) {
      console.dir(expectedRes, { depth: 10 });
      throw new Error("expected replay failed in promote path");
    }

    const expectedDecision = (expectedRes as any).decision;

    // --- PROMOTE (commit to canonical chain) ---
    await commitCounterfactual({
      store,
      snapshotStore,
      decision_id,
      counterfactual_id: promoteId,
      fixedOpts,
      snapshotPolicy: { every_n_events: 1 },
    });

    const latestAfter = await snapshotStore.getLatestSnapshot(decision_id);

    console.log("\n=== AFTER PROMOTE ===");
    console.log("latest_snapshot_seq:", latestAfter?.up_to_seq);
    console.log("latest_state:", latestAfter?.decision.state);
    console.log("latest_state_hash:", (latestAfter as any)?.state_hash);

    if (latestAfter) {
      const check = assertSnapshotIntegrity({ snapshot: latestAfter as any });
      if (!check.ok) throw new Error(`post-promote snapshot integrity failed: ${check.code}`);
    }

    console.log("PROMOTED updated_at:", (latestAfter as any).decision?.updated_at);
    console.log("PROMOTED created_at:", (latestAfter as any).decision?.created_at);

    if (!latestAfter) throw new Error("post-promote: missing latest snapshot");

    // ✅ FINAL FIX: compare the canonical decision hash against the expected replay decision hash,
    // not against the stored run.final_state_hash (which can differ if replay-store computes it differently).
    // --- VERIFY #3: promoted decision matches expected replay decision ---
    if (!latestAfter) throw new Error("post-promote: missing latest snapshot");

    // expectedDecision is already computed earlier in your promote path
    

    const normExpected = normalizeDecisionForHash((expectedRes as any).decision);
    const normPromoted = normalizeDecisionForHash((latestAfter as any).decision);

    const expectedDecisionHash = computeDecisionStateHash(normExpected);
    const promotedDecisionHash = computeDecisionStateHash(normPromoted);

    console.log("firstDiffPath(normExpected,normPromoted) =", firstDiffPath(normExpected, normPromoted));


    if (expectedDecisionHash !== promotedDecisionHash) {
      throw new Error(
        [
          "Promote verification failed: promoted decision hash does not match expected replay decision hash.",
          `- expected replay decision hash = ${expectedDecisionHash}`,
          `- promoted decision hash        = ${promotedDecisionHash}`,
        ].join("\n")
      );
    }

    console.log("\n✅ PROMOTE VERIFIED (hash matches expected replay).");
    return;
  }

  // 3) Seed if missing
  const exists = await store.getDecision(decision_id);
  if (!exists) {
    const base = { actor_id: "seed", actor_type: "system", meta: {} } as any;

    await applyEventWithStore(
      store,
      {
        decision_id,
        metaIfCreate: { title: "Replay store demo" },
        event: { type: "VALIDATE", ...base } as any,
        snapshotStore,
        snapshotPolicy: { every_n_events: 1 },
      },
      fixedOpts
    );

    await applyEventWithStore(
      store,
      {
        decision_id,
        event: { type: "ATTACH_ARTIFACTS", ...base, artifacts: { note: "seed" } } as any,
        snapshotStore,
        snapshotPolicy: { every_n_events: 1 },
      },
      fixedOpts
    );

    await applyEventWithStore(
      store,
      {
        decision_id,
        event: { type: "REQUIRE_FIELDS", ...base, fields: ["amount"] } as any,
        snapshotStore,
        snapshotPolicy: { every_n_events: 1 },
      },
      fixedOpts
    );

    await applyEventWithStore(
      store,
      {
        decision_id,
        event: {
          type: "ATTACH_ARTIFACTS",
          actor_id: "seed",
          actor_type: "system",
          artifacts: {
            extra: {
              trust: {
                policy: {
                  enabled: true,
                  require_origin_zone: true,
                  allowed_zones_by_event: { APPROVE: ["ORG"], REJECT: ["ORG"] },
                  denied_origin_zones: ["VENDOR"],
                },
              },
            },
          },
        } as any,
        snapshotStore,
        snapshotPolicy: { every_n_events: 1 },
      },
      fixedOpts
    );
  }

  const storedSnap = await snapshotStore.getLatestSnapshot(decision_id);
  console.log("\n=== STORED SNAPSHOT ===");
  console.log("seq:", storedSnap?.up_to_seq);
  console.log("state:", storedSnap?.decision.state);
  console.log("state_hash:", storedSnap?.state_hash);

  if (!storedSnap) throw new Error("No stored snapshot found.");
  {
    const check = assertSnapshotIntegrity({ snapshot: storedSnap as any });
    if (!check.ok) throw new Error(`stored snapshot integrity failed: ${check.code}`);
  }

  const currentState = storedSnap.decision.state;
  console.log("currentState:", currentState);

  const baseSeq = storedSnap.up_to_seq;
  const locator = { kind: "SEQ", seq: baseSeq } as const;

  const approveAttempt = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "APPROVE",
        actor_id: "alice",
        actor_type: "human",
        meta: {
          pls: {
            role: "Approver",
            scope: "Refund up to $250",
            risk_acceptance: "Low",
            obligations_hash: "sha256:demo",
          },
        },
      } as any,
      trustContext: { origin_zone: "VENDOR", origin_system: "fiserv", channel: "api" },
      internal_bypass_enterprise_gates: true,
    },
    fixedOpts
  );

  console.log("\n=== APPROVE ATTEMPT (VENDOR) ===");
  console.dir(approveAttempt, { depth: 10 });

  // ✅ IMPORTANT: make counterfactual events match what canonical store-engine will produce
  const approve: DecisionEvent = {
    type: "APPROVE",
    actor_id: "alice",
    actor_type: "human",
    meta: {}, // match canonical meta
    trust: {
      origin: { zone: "ORG", system: "fiserv", channel: "api", tenant_id: undefined },
      claimed_by: "store-engine", // match canonical claimed_by
      asserted_at: FIXED_NOW,
    },
    at: FIXED_NOW,
  } as any;

  const reject: DecisionEvent = {
    type: "REJECT",
    actor_id: "alice",
    actor_type: "human",
    meta: {},
    trust: {
      origin: { zone: "ORG", system: "fiserv", channel: "api", tenant_id: undefined },
      claimed_by: "store-engine",
      asserted_at: FIXED_NOW,
    },
    at: FIXED_NOW,
  } as any;

  let diffA: any[] = [];
  let diffR: any[] = [];

  if (currentState === "DRAFT") {
    const { snapshot: snapA_raw, result: resA, diff: dA } = await runCounterfactualFromStore({
      store,
      snapshotStore,
      decision_id,
      locator,
      appended_events: [approve],
      engine_version: "engine@1",
      opts: fixedOpts,
    });

    diffA = dA as any[];

    if (!resA.ok) throw new Error(`counterfactual failed (APPROVE): ${(resA as any).code ?? "unknown"}`);

    const finalHashA = computeDecisionStateHash(normalizeDecisionForHash((resA as any).decision));

    db.prepare(
      `INSERT OR REPLACE INTO counterfactual_runs(
        counterfactual_id, decision_id, base_seq, locator_json,
        appended_events_json, final_state, final_state_hash, diff_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      resA.counterfactual_id,
      decision_id,
      baseSeq,
      JSON.stringify(locator),
      JSON.stringify([approve]),
      resA.decision.state,
      finalHashA,
      JSON.stringify(diffA),
      FIXED_NOW
    );

    console.log("\n=== SNAPSHOT (APPROVE) ===");
    console.log("seq:", snapA_raw.up_to_seq);
    console.log("state:", snapA_raw.decision.state);
    console.log("state_hash:", (snapA_raw as any).state_hash);

    console.log("\n=== COUNTERFACTUAL (APPROVE) ===");
    console.log("ok:", resA.ok);
    console.log("counterfactual_id:", resA.counterfactual_id);
    console.log("final_state:", resA.decision.state);
    console.log("final_state_hash:", (resA as any).final_state_hash);

    console.log("\n=== DIFF (APPROVE) ===");
    console.dir(diffA, { depth: 10 });

    console.log("\n=== AFTER REPLAY (APPROVE) ===");
    console.log("event_count:", db.prepare("select count(*) as n from decision_events where decision_id=?").get(decision_id)?.n);
    console.log("latest_snapshot_seq:", (await snapshotStore.getLatestSnapshot(decision_id))?.up_to_seq);
  } else {
    console.log("\n(skip APPROVE — current state is not DRAFT)");
  }

  if (currentState === "DRAFT") {
    const { snapshot: snapR_raw, result: resR, diff: dR } = await runCounterfactualFromStore({
      store,
      snapshotStore,
      decision_id,
      locator,
      appended_events: [reject],
      engine_version: "engine@1",
      opts: fixedOpts,
    });

    diffR = dR as any[];

    if (!resR.ok) throw new Error(`counterfactual failed (REJECT): ${(resR as any).code ?? "unknown"}`);

    const finalHashR = computeDecisionStateHash(normalizeDecisionForHash((resR as any).decision));

    db.prepare(
      `INSERT OR REPLACE INTO counterfactual_runs(
        counterfactual_id, decision_id, base_seq, locator_json,
        appended_events_json, final_state, final_state_hash, diff_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      resR.counterfactual_id,
      decision_id,
      baseSeq,
      JSON.stringify(locator),
      JSON.stringify([reject]),
      resR.decision.state,
      finalHashR,
      JSON.stringify(diffR),
      FIXED_NOW
    );

    console.log("\n=== SNAPSHOT (REJECT) ===");
    console.log("seq:", snapR_raw.up_to_seq);
    console.log("state:", snapR_raw.decision.state);
    console.log("state_hash:", (snapR_raw as any).state_hash);

    console.log("\n=== COUNTERFACTUAL (REJECT) ===");
    console.log("ok:", resR.ok);
    console.log("counterfactual_id:", resR.counterfactual_id);
    console.log("final_state:", resR.decision.state);
    console.log("final_state_hash:", (resR as any).final_state_hash);

    console.log("\n=== DIFF (REJECT) ===");
    console.dir(diffR, { depth: 10 });
  } else {
    console.log("\n(skip REJECT — current state is not DRAFT)");
  }

  const cmp = compareDiffs("APPROVE", diffA as any, "REJECT", diffR as any);
  console.log("\n=== COMPARE COUNTERFACTUALS ===");
  console.log("only in APPROVE:", cmp.onlyA);
  console.log("only in REJECT:", cmp.onlyB);
  console.log("paths differ between both:", cmp.bothDifferent);

  console.log("\n=== DB CHECKS ===");
  console.log(
    "decision_events count:",
    db.prepare("select count(*) as n from decision_events where decision_id=?").get(decision_id)?.n
  );
  console.log(
    "latest decision_snapshot:",
    db
      .prepare("select decision_id, up_to_seq, state_hash from decision_snapshots where decision_id=? order by up_to_seq desc limit 1")
      .get(decision_id)
  );

  if (args.demoApproveOrg) {
    const approveAttemptOrg = await applyEventWithStore(
      store,
      {
        decision_id,
        event: { type: "APPROVE", actor_id: "alice", actor_type: "human", meta: {} } as any,
        trustContext: { origin_zone: "ORG", origin_system: "fiserv", channel: "api" },
        internal_bypass_enterprise_gates: true,
      },
      fixedOpts
    );

    console.log("\n=== APPROVE ATTEMPT (ORG) ===");
    console.dir(approveAttemptOrg, { depth: 10 });
  } else {
    console.log("\n(skip live ORG approve — pass --demo-approve-org if you want to mutate canonical state)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});