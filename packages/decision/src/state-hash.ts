// packages/decision/src/state-hash.ts
import crypto from "node:crypto";
import { stableNormalize, stableStringify } from "./stable-json.js";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Back-compat: older code imports normalizeForStateHash from here.
 * We define it as stableNormalize (key-sorted, deterministic).
 */
export function normalizeForStateHash(value: unknown): unknown {
  return stableNormalize(value);
}

/**
 * Base strip: remove purely non-deterministic / derived fields.
 * IMPORTANT: must be deterministic and must NOT contain exports inside.
 */
export function stripNonStateFieldsForHash(decision: any) {
  if (!decision || typeof decision !== "object") return decision;

  // Deep clone so deletes don't mutate caller.
  // (Assumes decision is JSON-safe; consistent with the rest of the codebase.)
  const d = JSON.parse(JSON.stringify(decision));

  // Non-deterministic / engine-mutated
  delete d.updated_at;
  delete d.version;

  // Derived hashes (must NEVER affect hashes; avoids self-referential hashing)
  delete d.public_state_hash;
  delete d.tamper_state_hash;

  // Optional alternate storage locations (belt-and-suspenders)
  if (d?.hashes && typeof d.hashes === "object") {
    delete d.hashes.public;
    delete d.hashes.tamper;
  }
  if (d?.state && typeof d.state === "object") {
    delete d.state.public_state_hash;
    delete d.state.tamper_state_hash;
    delete d.state.public_hash;
    delete d.state.tamper_hash;
  }

  // Derived / replay-only
  delete d.history;
  delete d.accountability;
  delete d.state;

  // Derived artifacts (must not affect hashes)
  delete d.signatures;

  // Audit-only / gate-only artifacts should not affect hashes
  try {
    if (d?.artifacts?.extra?.trust) delete d.artifacts.extra.trust;
    if (d?.artifacts?.extra?.liability_shield) delete d.artifacts.extra.liability_shield;
  } catch {
    // ignore
  }


  // ---- Hash hygiene: meta "patch/helper" fields must NOT affect hashes ----
  try {
    const m: any = d?.meta ?? null;
    if (m && typeof m === "object") {
      // 1) Generic rule: any meta keys that are clearly "patch/helper" should not hash
      for (const k of Object.keys(m)) {
        if (
          k.endsWith("_patch") ||
          k.endsWith("_helper") ||
          k.startsWith("patch_") ||
          k.startsWith("helper_")
        ) {
          delete m[k];
        }
      }

      // 2) Known transient compat keys (keep these explicit)
      delete m.ai_generated;
      delete m.system_generated;
      delete m.ai_model;
      delete m.system_id;
      delete m.generated_at;
      delete m.attribution_note;
    }
  } catch {
    // ignore
  }

  return d;
}

/**
 * Tamper hash: store-integrity hash.
 * - includes everything except derived/non-deterministic fields.
 * - safe for internal DB integrity checks.
 */
export function stripForTamperHash(decision: any) {
  return stripNonStateFieldsForHash(decision);
}

/**
 * Public hash: portable identity hash.
 * - additionally removes private/internal artifacts.
 * - intended for external sharing/anchoring.
 */
export function stripForPublicHash(decision: any) {
  const d = stripNonStateFieldsForHash(decision);

  if (d && typeof d === "object") {
    // already deleted above, but keep belt-and-suspenders
    delete (d as any).signatures;
  }

  // Remove trust/liability extras (belt-and-suspenders)
  try {
    if ((d as any).artifacts?.extra?.trust) delete (d as any).artifacts.extra.trust;
    if ((d as any).artifacts?.extra?.liability_shield) delete (d as any).artifacts.extra.liability_shield;
  } catch {
    // ignore
  }

  // Public hash MUST NOT include private/internal artifacts
  try {
    if ((d as any).artifacts?.private) delete (d as any).artifacts.private;
    if ((d as any).artifacts?.internal) delete (d as any).artifacts.internal;
    if ((d as any).artifacts?.extra?.private_internal_only)
      delete (d as any).artifacts.extra.private_internal_only;
  } catch {
    // ignore
  }

  return d;
}

export function computeTamperStateHash(decision: any): string {
  return sha256Hex(
    stableStringify({
      kind: "TAMPER_STATE_HASH_V1",
      decision: stripForTamperHash(decision),
    })
  );
}

export function computePublicStateHash(decision: any): string {
  return sha256Hex(
    stableStringify({
      kind: "PUBLIC_STATE_HASH_V1",
      decision: stripForPublicHash(decision),
    })
  );
}

/**
 * Back-compat: computeDecisionStateHash historically meant "the state hash".
 * We now define it as the tamper hash (store-integrity).
 */

export function computeDecisionStateHash(decision: any): string {
  return computeTamperStateHash(decision);
}


