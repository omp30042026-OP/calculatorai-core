// examples/run-decision-consequence-block.ts
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

  const decision_id = "dec_consequence_block_001";
  const snapshotPolicy = { every_n_events: 1 };
  const anchorPolicy = { enabled: true };

  // 1) VALIDATE
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id,
      metaIfCreate: { title: "Consequence Block Demo", owner_id: "system" },
      event: { type: "VALIDATE", actor_id: "system" },
      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy,
    },
    opts
  );
  if (!r1.ok) throw new Error("validate blocked");

  // 2) ❌ TRY TO APPROVE WITHOUT SIMULATE
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id,
      event: { type: "APPROVE", actor_id: "system" },

      snapshotStore: store,
      snapshotPolicy,
      anchorStore: store,
      anchorPolicy,

      // 🔥 THIS IS THE KEY FLAG
      block_on_consequence_block: true,
    },
    opts
  );

  // Print result
  process.stdout.write(
    JSON.stringify(
      {
        ok: r2.ok,
        consequence_preview: r2.consequence_preview,
        violations: (r2 as any).violations ?? null,
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

