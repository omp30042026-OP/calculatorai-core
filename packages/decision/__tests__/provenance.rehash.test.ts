import { describe, it, expect } from "vitest";
import { createDecisionV2 } from "../src/decision";
import { replayDecision } from "../src/engine";
import { verifyProvenanceChain } from "../src/provenance";
import crypto from "node:crypto";

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

function computeNodeHashLikeProvenanceTs(node: any): string {
  const { node_hash: _ignore, at: _at, ...rest } = node ?? {};
  return sha256Hex(stableStringify(rest));
}

describe("provenance rehash attack", () => {
  it("fails even if attacker edits a node and recomputes node_hash (because node_id and linkage become inconsistent)", () => {
    const now = () => "2026-01-19T00:00:00.000Z";

    const root = createDecisionV2(
      { decision_id: "dec_prov_rehash_001", meta: { title: "Test", owner_id: "u1" }, artifacts: {}, version: 1 } as any,
      now
    ) as any;

    const rr = replayDecision(
      root,
      [
        { type: "VALIDATE", actor_id: "u1", actor_type: "human" } as any,
        { type: "SIMULATE", actor_id: "u1", actor_type: "human" } as any,
      ],
      { now }
    );

    if (rr.ok === false) {
      throw new Error("Replay failed unexpectedly: " + JSON.stringify(rr.violations ?? [], null, 2));
    }

    const decision = rr.decision as any;
    expect(verifyProvenanceChain(decision).ok).toBe(true);

    const nodes = decision?.artifacts?.extra?.provenance?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) throw new Error("Expected 2+ nodes");

    // attacker tampers node 0 then recomputes node_hash
    nodes[0].event_type = "HACKED";
    nodes[0].node_hash = computeNodeHashLikeProvenanceTs(nodes[0]);

    // should still fail because node_id is derived from payload including event_type,
    // and node_id was NOT recomputed (and downstream linkage can also break)
    const vr = verifyProvenanceChain(decision);
    expect(vr.ok).toBe(false);
  });
});

