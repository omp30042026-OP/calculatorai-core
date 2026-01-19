// examples/run-decision-ingestion.ts
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

  const decision_id = "dec_ingest_001";

  const validate = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Ingestion Demo", owner_id: "system", source: "demo" },
      event: { type: "VALIDATE", actor_id: "alice" },
      idempotency_key: "v1",
    },
    opts
  );

  const ingest_pos = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "INGEST_RECORDS",
        actor_id: "alice",
        source: "POS",
        records: [
          {
            source_system: "POS",
            source_record_id: "order_1001",
            occurred_at: now(),
            entity_type: "order",
            payload: { total: 47.25, currency: "USD", store_id: "SFO-01" },
          },
        ],
      } as any,
      idempotency_key: "ing1",
    },
    opts
  );

  // re-ingest same record -> should dedupe
  const ingest_pos_duplicate = await applyEventWithStore(
    store,
    {
      decision_id,
      event: {
        type: "INGEST_RECORDS",
        actor_id: "alice",
        source: "POS",
        records: [
          {
            source_system: "POS",
            source_record_id: "order_1001",
            occurred_at: now(),
            entity_type: "order",
            payload: { total: 47.25, currency: "USD", store_id: "SFO-01" },
          },
        ],
      } as any,
      idempotency_key: "ing2",
    },
    opts
  );

  process.stdout.write(
    JSON.stringify({ validate, ingest_pos, ingest_pos_duplicate }, null, 2) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

