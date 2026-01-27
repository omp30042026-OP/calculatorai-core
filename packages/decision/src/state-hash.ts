// packages/decision/src/state-hash.ts
import crypto from "node:crypto";



// packages/decision/src/state-hash.ts

export function normalizeForStateHash(value: unknown): unknown {
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

  return norm(value as any);
}

// --- shared stable stringify (must match store-engine semantics) ---
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

/**
 * Canonical decision hash (already used across the system).
 * If you already have this function in this file, DO NOT duplicate it.
 * Keep your existing implementation.
 */
export function computeDecisionStateHash(decision: any): string {
  // If this function already exists in your file, delete this duplicate.
  return sha256Hex(stableStringify(decision));
}

// -----------------------------
// ✅ Strip helper (exported, shared)
// -----------------------------
export function stripNonStateFieldsForHash(decision: any) {
  if (!decision) return decision;

  const d = JSON.parse(JSON.stringify(decision));

  // top-level volatile/derived
  delete d.signatures;
  delete d.provenance;
  delete d.snapshots;
  delete d.anchors;

  delete d._debug;
  delete d.debug;
  delete d.audit;

  // also strip provenance stored under artifacts
  if (d.artifacts && typeof d.artifacts === "object") {
    delete d.artifacts.provenance;

    const extra = d.artifacts.extra;
    if (extra && typeof extra === "object") {
      delete extra.provenance;
      if (Object.keys(extra).length === 0) {
        delete d.artifacts.extra;
      }
    }
  }

  return d;
}

// -----------------------------
// ✅ Hashes (exported, shared)
// -----------------------------
export function computeTamperStateHash(decision: any): string {
  let d: any;
  try {
    d = JSON.parse(stableStringify(decision));
  } catch {
    d = decision;
  }

  if (d && typeof d === "object") {
    delete d.history;
    delete d.accountability;

    delete d.amount;
    delete d.fields_amount;
    delete d.artifacts_amount;

    if (d.artifacts?.extra && typeof d.artifacts.extra === "object") {
      delete (d.artifacts.extra as any).liability_shield;
      delete (d.artifacts.extra as any).pls;
      delete (d.artifacts.extra as any).trust;

      if (Object.keys(d.artifacts.extra as any).length === 0) {
        delete (d.artifacts as any).extra;
      }
    }

    delete d.updated_at;
    delete d.created_at;
    delete d.deleted_at;
    delete d.archived_at;
    delete d.version;

    delete d.execution;

    if (d.fields && typeof d.fields === "object") {
      delete d.fields.amount;
      if (Object.keys(d.fields).length === 0) delete d.fields;
    }

    delete d.signatures;

    if (d.artifacts && typeof d.artifacts === "object") {
      delete d.artifacts.execution;
      delete d.artifacts.workflow;
      delete d.artifacts.workflow_status;

      const extra = (d.artifacts as any).extra;
      if (extra && typeof extra === "object") {
        delete extra.execution;
        delete extra.workflow;
        delete extra.workflow_status;

        if (Object.keys(extra).length === 0) {
          delete (d.artifacts as any).extra;
        }
      }
    }
  }

  return computeDecisionStateHash(d);
}

export function computePublicStateHash(decision: any): string {
  let d: any;
  try {
    d = JSON.parse(stableStringify(decision));
  } catch {
    d = decision;
  }

  if (d && typeof d === "object") {
    delete d.history;
    delete d.accountability;

    delete d.updated_at;
    delete d.created_at;
    delete d.deleted_at;
    delete d.archived_at;
    delete d.version;

    delete d.amount;
    delete d.fields_amount;
    delete d.artifacts_amount;

    if (d.fields && typeof d.fields === "object") {
      delete d.fields.amount;
      if (Object.keys(d.fields).length === 0) delete d.fields;
    }

    delete d.signatures;
    delete d.execution;

    if (d.artifacts && typeof d.artifacts === "object") {
      delete d.artifacts.execution;
      delete d.artifacts.workflow;
      delete d.artifacts.workflow_status;

      const extra = (d.artifacts as any).extra;
      if (extra && typeof extra === "object") {
        delete extra.execution;
        delete extra.workflow;
        delete extra.workflow_status;

        delete extra.liability_shield;
        delete extra.pls;
        delete extra.trust;

        if (Object.keys(extra).length === 0) {
          delete (d.artifacts as any).extra;
        }
      }
    }
  }

  return computeDecisionStateHash(d);
}


