import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";

function makeDeterministicNow(start = 1_700_000_000_000) {
  let t = start;
  return () => new Date(t++).toISOString();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const now = makeDeterministicNow();

  let d = createDecisionV2(
    { decision_id: "dec_tamper_1", meta: { owner_id: "user_1", title: "Tamper Test" }, artifacts: {} },
    now
  );

  let r1 = applyDecisionEvent(d, { type: "VALIDATE", actor_id: "user_1" }, { now });
    assert(r1.ok, "validate should pass");
    d = r1.decision;

  // build provenance
  for (const e of [
    { type: "VALIDATE", actor_id: "user_1" },
    { type: "ATTACH_ARTIFACTS", actor_id: "user_1", artifacts: { x: 1 } },
    { type: "EXPLAIN", actor_id: "user_1" },
  ] as any[]) {
    const r = applyDecisionEvent(d as any, e as any, { now });
    assert(r.ok, JSON.stringify(r, null, 2));
    d = r.decision;
  }

  // tamper
    const provCompat = (d as any).artifacts?.provenance;
    const provCanon  = (d as any).artifacts?.extra?.provenance;

    const prov = provCompat ?? provCanon;
    assert(prov?.nodes?.length, "missing provenance nodes");

    // tamper compat (the one engine reads first)
    if (provCompat?.nodes?.length) provCompat.nodes[0].event_type = "HACKED";
    // also tamper canonical so both stay consistent
    if (provCanon?.nodes?.length)  provCanon.nodes[0].event_type  = "HACKED";

  // next event should fail with PROVENANCE_TAMPERED
  const r2 = applyDecisionEvent(d as any, { type: "SIMULATE", actor_id: "user_1" } as any, { now });
  assert(!r2.ok, "expected failure after tamper");
  assert(
    r2.violations?.some((v: any) => v.code === "PROVENANCE_TAMPERED"),
    "expected PROVENANCE_TAMPERED"
  );

  console.log("✅ provenance tamper detection ok");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

