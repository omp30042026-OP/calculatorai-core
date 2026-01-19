import { createDecisionV2, applyDecisionEvent, replayDecision } from "../packages/decision/src/engine.js";
import { InMemoryDecisionStore } from "../packages/decision/src/in-memory-store.js";
import type { DecisionEvent } from "../packages/decision/src/events.js";


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
  return JSON.stringify(norm(value), null, 2);
}

function firstDiff(a: any, b: any, path = "$"): { path: string; a: any; b: any } | null {
  if (a === b) return null;

  const aIsObj = a && typeof a === "object";
  const bIsObj = b && typeof b === "object";

  if (!aIsObj || !bIsObj) return { path, a, b };

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path, a, b };
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.join("|") !== bKeys.join("|")) {
    return { path: `${path}.__keys__`, a: aKeys, b: bKeys };
  }

  for (const k of aKeys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }

  return null;
}



function makeDeterministicNow(start = 1_700_000_000_000) {
  let t = start;
  return () => new Date(t++).toISOString();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const now = makeDeterministicNow();
  const store = new InMemoryDecisionStore();

  // 1) Create root decision and store it
  const decision_id = "dec_store_1";

  // NOTE: createDecisionV2 signature in your codebase is (input, nowFn)
  const root = createDecisionV2(
    {
      decision_id,
      meta: { title: "Store Replay", owner_id: "user_1" },
      artifacts: {},
    },
    now
  );

  await store.createDecision(root);

  // 2) Apply events one-by-one, append to log, persist current snapshot
  const events: DecisionEvent[] = [
    { type: "VALIDATE", actor_id: "user_1" },
    { type: "ATTACH_ARTIFACTS", actor_id: "user_1", artifacts: { margin_snapshot_id: "m_001" } },
    { type: "SIMULATE", actor_id: "user_1" },
    { type: "EXPLAIN", actor_id: "user_1" },
  ];

  let cur = root;
  for (const e of events) {
    const r = applyDecisionEvent(cur, e, { now });
    assert(r.ok, `applyDecisionEvent failed: ${JSON.stringify(r, null, 2)}`);
    cur = r.decision;

    const appliedAt =
      cur.history && cur.history.length
        ? cur.history[cur.history.length - 1]!.at
        : new Date(0).toISOString(); // should never hit

    await store.appendEvent(decision_id, { at: appliedAt, event: e });
    await store.putDecision(cur);
  }

  const storedCurrent = await store.getDecision(decision_id);
  assert(storedCurrent !== null, "missing current snapshot");

  // 3) Replay from root + stored events and compare important invariants
  const storedRoot = await store.getRootDecision(decision_id);
  assert(storedRoot !== null, "missing root snapshot");

  const log = await store.listEvents(decision_id);
  const replayEvents = log.map((x) => x.event);

  const rr = replayDecision(storedRoot, replayEvents, { now: makeDeterministicNow(1_700_000_000_000) });
  assert(rr.ok, `replayDecision failed: ${JSON.stringify(rr, null, 2)}`);

  // Compare core invariants (ignore timestamps)
  assert(rr.decision.state === storedCurrent.state, "state mismatch after replay");

  const artReplay = rr.decision.artifacts ?? {};
  const artStored = storedCurrent.artifacts ?? {};

  const d = firstDiff(artReplay, artStored);
  if (d) {
    console.error("❌ artifacts mismatch after replay @", d.path);
    console.error("replay:", d.a);
    console.error("stored:", d.b);

    // also print stable whole objects (sorted keys) so ordering never hides the issue
    console.error("---- replay artifacts (stable) ----\n" + stableStringify(artReplay));
    console.error("---- stored artifacts (stable) ----\n" + stableStringify(artStored));
  }

  assert(!d, "artifacts mismatch after replay");

  assert(
    (rr.decision.history?.length ?? 0) === (storedCurrent.history?.length ?? 0),
    "history length mismatch after replay"
  );

  console.log("✅ Decision store replay ok:", {
    state: rr.decision.state,
    artifacts: rr.decision.artifacts ?? {},
    events: log.length,
  });
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

