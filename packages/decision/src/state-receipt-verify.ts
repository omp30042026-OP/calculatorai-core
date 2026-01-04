// packages/decision/src/state-receipt-verify.ts
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

export function computeDecisionStateHash(decision: unknown): string {
  return sha256Hex(stableStringify(decision));
}

/**
 * Works with:
 * - V2: { receipt: { ... state_hash ... }, head: ... }
 * - V1: { anchor: { ... state_hash ... }, pinned_head: ... }
 */
export function verifyDecisionStateAgainstReceipt(receipt: any, decision: unknown): {
  ok: boolean;
  expected_state_hash?: string | null;
  actual_state_hash?: string;
  message?: string;
} {
  const expected: string | null | undefined =
    receipt?.receipt?.state_hash ?? receipt?.anchor?.state_hash ?? null;

  if (!expected) {
    return { ok: false, expected_state_hash: expected ?? null, message: "Receipt missing state_hash." };
  }

  const actual = computeDecisionStateHash(decision);

  return {
    ok: actual === expected,
    expected_state_hash: expected,
    actual_state_hash: actual,
    message: actual === expected ? "State hash matches receipt." : "State hash mismatch.",
  };
}

