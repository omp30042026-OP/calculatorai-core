// examples/run-decision-dia-sqlite.ts
import { createSqliteStoreBundle } from "./your-store-factory.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { ensureDiaTables, makeSqliteDiaStore } from "../packages/decision/src/dia-store-sqlite.js";
import { computeDiaHashV1 } from "../packages/decision/src/dia.js";
import { verifyStoredDiaRow } from "../packages/decision/src/dia-store-sqlite.js";

async function main() {
  const { store, filename } = createSqliteStoreBundle();
  console.log("sqlite file:", filename);

  // ✅ ALWAYS use the store's internal db (the one store-engine uses)
  const storeDb = (store as any).db;
  if (!storeDb) throw new Error("Store has no .db; SqliteDecisionStore expected.");

  // ✅ Create diaStore from the SAME db
  const diaStore = makeSqliteDiaStore(storeDb);

  // make sure the DIA table exists
  ensureDiaTables(storeDb);

  const r0 = await applyEventWithStore(store, {
    decision_id: "dec_dia_001",

    // Use an event that won't require title/owner gates if possible
    // but we also pass metaIfCreate so the root is valid either way.
    event: { type: "ATTACH_ARTIFACTS", actor_id: "seed", actor_type: "system" } as any,

    // ✅ this is the key: when the decision is created, store-engine will use this meta
    metaIfCreate: {
        title: "DIA test decision",
        owner_id: "u1",
    },

    diaStore,
    internal_bypass_enterprise_gates: true,
    });

 console.log("seed/apply ok:", r0.ok);
 if (!r0.ok) console.log("seed violations:", (r0 as any).violations);

  // 2) finalize-by-event (APPROVE/REJECT/PUBLISH)
  const r = await applyEventWithStore(store, {
    decision_id: "dec_dia_001",
    event: { type: "APPROVE", actor_id: "u1", actor_type: "human" } as any,
    emit_dia_on_finalize: true,
    require_dia_on_finalize: true,   // ✅ ADD THIS
    diaStore,
    internal_bypass_enterprise_gates: true,
  });

  console.log("apply ok:", r.ok);
  if (!r.ok) console.log("violations:", r.violations);

  // ✅ Query the SAME db that diaStore wrote to
  const rows = storeDb.prepare(`
    SELECT decision_id, event_seq, dia_kind, dia_hash
    FROM decision_attestations
    WHERE decision_id=?
    ORDER BY event_seq ASC
  `).all("dec_dia_001");

  const evs = storeDb.prepare(`
    SELECT decision_id, seq, at, event_json
    FROM decision_events
    WHERE decision_id=?
    ORDER BY seq ASC
    `).all("dec_dia_001");

    console.log("EVENT rows:", evs.map((r: any) => ({ seq: r.seq, event: JSON.parse(r.event_json).type })));

  console.log("DIA rows:", rows);


    // ✅ Verify row integrity (recompute hash from stored dia_json)
    const v = verifyStoredDiaRow({
    db: storeDb,
    decision_id: "dec_dia_001",
    event_seq: 2, // this is where your DIA is written
    });

    console.log("verify:", v);

    // ✅ Tamper test: modify dia_json and ensure verification fails
    storeDb.prepare(`
    UPDATE decision_attestations
    SET dia_json='{"kind":"DIA_V1","tampered":true}'
    WHERE decision_id=? AND event_seq=? AND dia_kind='DIA_V1'
    `).run("dec_dia_001", 2);

    const v2 = verifyStoredDiaRow({
    db: storeDb,
    decision_id: "dec_dia_001",
    event_seq: 2,
    });

    console.log("verify after tamper:", v2);



}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

