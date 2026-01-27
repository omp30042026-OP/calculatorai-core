// examples/run-replay-counterfactual.ts
import { readFileSync } from "node:fs";
import { createDecisionV2 } from "../packages/decision/src/decision";
import type { DecisionEvent } from "../packages/decision/src/events";
import { getReplaySnapshot, replayFromSnapshot, diffDecisions } from "../packages/decision/src/replay";

function nowIso(): string {
  // deterministic enough for a demo; engine will overwrite updated_at using opts.now
  return new Date().toISOString();
}

function main() {
  // 1) Base decision (deterministic replay: pass opts.now)
  const base = createDecisionV2(
    {
      decision_id: "dec_demo_replay",
      meta: { demo: true },
      artifacts: { extra: {} } as any,
    },
    () => "2026-01-21T00:00:00.000Z"
  );

  // 2) Load an existing event stream if you want (optional)
  //    If you have a JSON file in examples/decisions you can use it.
  //    Otherwise we use a built-in small list.
  let events: DecisionEvent[] = [];
  try {
    const raw = readFileSync("examples/decisions/single.json", "utf8");
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed?.events)
        ? (parsed.events as DecisionEvent[])
        : Array.isArray(parsed)
            ? (parsed as DecisionEvent[])
            : Array.isArray(parsed?.history)
            ? (parsed.history as DecisionEvent[])
            : [];
  } catch {
    // fallback demo stream
    events = [
      { type: "VALIDATE", actor_id: "alice", actor_type: "human" } as any,
      { type: "EXPLAIN", actor_id: "system", actor_type: "system" } as any,
      {
        type: "ADD_OBLIGATION",
        actor_id: "alice",
        actor_type: "human",
        obligation_id: "obl_ship_24h",
        title: "Ship order within 24h",
        due_at: "2026-01-22T00:00:00.000Z",
        severity: "WARN",
      } as any,
    ];
  }
   if (!events.length) {
        events = [
            { type: "VALIDATE", actor_id: "alice", actor_type: "human" } as any,
            { type: "EXPLAIN", actor_id: "system", actor_type: "system" } as any,
            {
            type: "ADD_OBLIGATION",
            actor_id: "alice",
            actor_type: "human",
            obligation_id: "obl_ship_24h",
            title: "Ship order within 24h",
            due_at: "2026-01-22T00:00:00.000Z",
            severity: "WARN",
            } as any,
        ];
    }
    console.log("Loaded events:", events.length, "first:", events[0]?.type);
  // 3) Snapshot: replay up to index=2 (apply first 2 events)
  const snapshot = getReplaySnapshot({
    decision_id: (base as any).decision_id ?? null,
    base,
    events,
    locator: { kind: "INDEX", index: 2 },
    opts: {
      now: () => "2026-01-21T12:00:00.000Z",
    },
  });

  console.log("=== SNAPSHOT ===");
  console.log("index:", snapshot.index);
  console.log("state:", snapshot.decision.state);
  console.log("state_hash:", snapshot.state_hash);

  // 4) Counterfactual A: append APPROVE
  const cfApprove = replayFromSnapshot({
    snapshot,
    appended_events: [{
      type: "APPROVE",
      actor_id: "bob",
      actor_type: "human",
      meta: {
        pls: {
          role: "Approver",
          scope: "Counterfactual approval",
          risk_acceptance: "Medium",
          obligations_hash: "sha256:demo",
        },
      },
    } as any],
    opts: {
      now: () => "2026-01-21T12:00:00.000Z",
    },
    engine_version: "decision-engine@1.1.0",
  });

  console.log("\n=== COUNTERFACTUAL: APPROVE ===");
  console.log("ok:", cfApprove.ok);
  console.log("counterfactual_id:", cfApprove.counterfactual_id);
  console.log("final_state_hash:", cfApprove.final_state_hash);
  if (cfApprove.ok) {
    console.log("final_state:", cfApprove.decision.state);
    console.log("diff:", diffDecisions(snapshot.decision, cfApprove.decision).slice(0, 20));
  } else {
    console.log("violations:", (cfApprove as any).violations);
  }

  // 5) Counterfactual B: append REJECT with reason
  const cfReject = replayFromSnapshot({
    snapshot,
    appended_events: [{ type: "REJECT", actor_id: "bob", actor_type: "human", reason: "risk too high" } as any],
    opts: {
      now: () => "2026-01-21T12:00:00.000Z",
    },
    engine_version: "decision-engine@1.1.0",
  });

  console.log("\n=== COUNTERFACTUAL: REJECT ===");
  console.log("ok:", cfReject.ok);
  console.log("counterfactual_id:", cfReject.counterfactual_id);
  console.log("final_state_hash:", cfReject.final_state_hash);
  if (cfReject.ok) {
    console.log("final_state:", cfReject.decision.state);
    console.log("diff:", diffDecisions(snapshot.decision, cfReject.decision).slice(0, 20));
  } else {
    console.log("violations:", (cfReject as any).violations);
  }
}

main();



