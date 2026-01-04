import crypto from "node:crypto";

export type DecisionAnchorRecord = {
  seq: number; // global monotonically increasing
  at: string; // ISO timestamp

  decision_id: string;
  snapshot_up_to_seq: number;

  // snapshot integrity (copied from snapshot row)
  checkpoint_hash?: string | null;
  root_hash?: string | null;

  // ✅ Feature 32: decision state attestation
  state_hash?: string | null;

  // tamper-evident global chain
  prev_hash?: string | null;
  hash?: string | null;
};

export type AppendAnchorInput = Omit<
  DecisionAnchorRecord,
  "seq" | "prev_hash" | "hash"
>;

export type DecisionAnchorStore = {
  appendAnchor(input: AppendAnchorInput): Promise<DecisionAnchorRecord>;
  listAnchors(): Promise<DecisionAnchorRecord[]>;

  // optional helpers
  getLastAnchor?(): Promise<DecisionAnchorRecord | null>;

  // ✅ Feature 27: canonical lookup (sqlite-store implements this)
  getAnchorForSnapshot?(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null>;

  // ✅ Back-compat helper name (some code uses this name)
  findAnchorByCheckpoint?(
    decision_id: string,
    snapshot_up_to_seq: number
  ): Promise<DecisionAnchorRecord | null>;

  // ✅ Feature 26 retention: keep last N anchors globally
  pruneAnchors?(
    keep_last_n: number
  ): Promise<{ deleted: number; remaining: number }>;
};


export type AnchorPolicy = {
  enabled: boolean;
};

// -------------------------
// Stable hashing (must match your event hashing style)
// -------------------------
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

export function computeAnchorHash(input: {
  seq: number;
  at: string;
  decision_id: string;
  snapshot_up_to_seq: number;
  checkpoint_hash?: string | null;
  root_hash?: string | null;
  state_hash?: string | null; // ✅ Feature 32
  prev_hash?: string | null;
}): string {
  const payload = stableStringify({
    seq: input.seq,
    at: input.at,
    decision_id: input.decision_id,
    snapshot_up_to_seq: input.snapshot_up_to_seq,
    checkpoint_hash: input.checkpoint_hash ?? null,
    root_hash: input.root_hash ?? null,
    state_hash: input.state_hash ?? null, // ✅ Feature 32
    prev_hash: input.prev_hash ?? null,
  });

  return sha256Hex(payload);
}

