// packages/decision/src/forensic.ts
import crypto from "node:crypto";

import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionStore, DecisionEventRecord } from "./store.js";
import { createDecisionV2 } from "./decision.js";
import { replayDecision } from "./engine.js";

// -----------------------------
// MUST MATCH sqlite-store.ts
// -----------------------------
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

function computeEventHash(input: {
  decision_id: string;
  seq: number;
  at: string;
  idempotency_key?: string | null;
  event: DecisionEvent;
  prev_hash?: string | null;
}): string {
  // IMPORTANT: field names + null handling must match sqlite-store.ts
  const payload = stableStringify({
    decision_id: input.decision_id,
    seq: input.seq,
    at: input.at,
    idempotency_key: input.idempotency_key ?? null,
    event: input.event,
    prev_hash: input.prev_hash ?? null,
  });

  return sha256Hex(payload);
}

// ---------------------------------
// Canonical genesis DRAFT for replay
// - MUST NOT include stored history/artifacts from DB head
// - Use stored created_at/meta for deterministic timestamps + metadata
// ---------------------------------
function canonicalDraftRootFromStored(root: Decision): Decision {
  const created_at = root.created_at ?? "2025-01-01T00:00:00.000Z";
  const nowFn = () => created_at;

  const d = createDecisionV2(
    {
      decision_id: root.decision_id,
      parent_decision_id: (root as any).parent_decision_id ?? undefined, // ✅ ADD THIS
      meta: (root.meta ?? {}) as any,
      artifacts: { extra: {} } as any,
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at };
}

// Fallback if decision doesn't exist in store yet
function canonicalDraftRoot(decision_id: string, meta?: Record<string, unknown>): Decision {
  const created_at = "2025-01-01T00:00:00.000Z";
  const nowFn = () => created_at;

  const d = createDecisionV2(
    {
      decision_id,
      meta: meta ?? {},
      artifacts: { extra: {} } as any,
      version: 1,
    } as any,
    nowFn
  );

  return { ...d, state: "DRAFT", created_at, updated_at: created_at };
}

export type HashChainError = {
  seq: number;
  expected_hash: string;
  stored_hash: string | null;
  stored_prev_hash: string | null;
  computed_prev_hash: string | null;
};

export async function forensicReplayAndVerify(
  store: DecisionStore,
  decision_id: string
): Promise<{
  ok: boolean;
  decision: Decision;
  event_count: number;
  hash_chain_verified: boolean;
  hash_chain_errors: HashChainError[];
}> {
  const events: DecisionEventRecord[] = await store.listEvents(decision_id);

  // 1) verify hash chain
  const errors: HashChainError[] = [];
  let prevExpected: string | null = null;

  for (const r of events) {
    const expected = computeEventHash({
      decision_id: r.decision_id,
      seq: r.seq,
      at: r.at,
      idempotency_key: r.idempotency_key ?? null,
      event: r.event,
      prev_hash: prevExpected,
    });

    const stored_hash = (r as any).hash ?? null;
    const stored_prev_hash = (r as any).prev_hash ?? null;

    const prevOk = stored_prev_hash === prevExpected;
    const hashOk = stored_hash === expected;

    if (!prevOk || !hashOk) {
      errors.push({
        seq: r.seq,
        expected_hash: expected,
        stored_hash,
        stored_prev_hash,
        computed_prev_hash: prevExpected,
      });
    }

    prevExpected = expected;
  }

  const hash_chain_verified = errors.length === 0;

  // 2) replay from clean canonical genesis (NOT from stored head/root JSON)
  const root = (await store.getRootDecision(decision_id)) ?? null;

  const base = root
    ? canonicalDraftRootFromStored(root)
    : canonicalDraftRoot(decision_id, { owner_id: "system" });

  const rr = replayDecision(base, events.map((e) => e.event), {});

  return {
    ok: rr.ok,
    decision: rr.decision,
    event_count: events.length,
    hash_chain_verified,
    hash_chain_errors: errors,
  };
}


