// packages/decision/src/hash.ts
import { createHash } from "node:crypto";

/**
 * Stable (canonical) JSON stringify:
 * - object keys are sorted
 * - arrays preserve order
 * - undefined is omitted in objects (like JSON.stringify)
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;

  const t = typeof value;

  if (t === "string" || t === "number" || t === "boolean") return value;

  if (Array.isArray(value)) return value.map(canonicalize);

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (typeof v === "undefined") continue;
      out[k] = canonicalize(v);
    }
    return out;
  }

  // functions/symbols/etc are not representable in JSON
  return null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeEventHash(input: {
  decision_id: string;
  seq: number;
  at: string;
  event: unknown;
  idempotency_key?: string | null;
  prev_hash?: string | null;
}): string {
  const payload = canonicalJson({
    decision_id: input.decision_id,
    seq: input.seq,
    at: input.at,
    idempotency_key: input.idempotency_key ?? null,
    prev_hash: input.prev_hash ?? null,
    event: input.event,
  });

  return sha256Hex(payload);
}

