import fs from "node:fs";
import path from "node:path";

import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

async function main() {
  const dbFile = path.join(process.cwd(), "tmp-decision-durability.sqlite");
  try {
    fs.unlinkSync(dbFile);
  } catch {}

  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const decision_id = "dec_durable_001";
  const snapshotPolicy = { every_n_events: 3 };

  // ---- Phase 1: create + validate + simulate + generate snapshots ----
  {
    const store = new SqliteDecisionStore(dbFile);

    const r1 = await applyEventWithStore(
      store,
      {
        decision_id,
        metaIfCreate: {
          title: "Durability Demo",
          owner_id: "system",
          source: "durability-test",
        },
        event: { type: "VALIDATE", actor_id: "system" },
        snapshotStore: store,
        snapshotPolicy,
        idempotency_key: "validate-1",
      },
      opts
    );
    assert(r1.ok, "validate failed");

    const r2 = await applyEventWithStore(
      store,
      {
        decision_id,
        event: { type: "SIMULATE", actor_id: "system" },
        snapshotStore: store,
        snapshotPolicy,
        idempotency_key: "simulate-1",
      },
      opts
    );
    assert(r2.ok, "simulate failed");

    // create enough events to force snapshot(s)
    for (let i = 0; i < 7; i++) {
      const r = await applyEventWithStore(
        store,
        {
          decision_id,
          event: {
            type: "ATTACH_ARTIFACTS",
            actor_id: "system",
            artifacts: { extra: { tick: i } },
          },
          snapshotStore: store,
          snapshotPolicy,
          idempotency_key: `tick-${i}`,
        },
        opts
      );
      assert(r.ok, `tick ${i} failed`);
    }

    const snap = await store.getLatestSnapshot(decision_id);
    assert(snap, "missing snapshot in phase 1");
    assert(snap.up_to_seq >= 3, "snapshot did not advance in phase 1");
  }

  // ---- Phase 2: "restart" (new store instance) and continue safely ----
  {
    const store = new SqliteDecisionStore(dbFile);

    // Idempotency replay: re-send same simulate event; must NOT break state
    const rReplay = await applyEventWithStore(
      store,
      {
        decision_id,
        event: { type: "SIMULATE", actor_id: "system" },
        snapshotStore: store,
        snapshotPolicy,
        idempotency_key: "simulate-1", // same key as earlier
      },
      opts
    );
    assert(rReplay.ok, "idempotent replay simulate failed");

    const snap2 = await store.getLatestSnapshot(decision_id);
    assert(snap2, "missing snapshot after restart");

    const cur = await store.getDecision(decision_id);
    assert(cur, "missing current after restart");

    console.log(
      JSON.stringify(
        {
          decision_id,
          state: cur.state,
          current_version: cur.version,
          snapshot_up_to_seq: snap2.up_to_seq,
        },
        null,
        2
      )
    );
  }

  // cleanup
  try {
    fs.unlinkSync(dbFile);
  } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

