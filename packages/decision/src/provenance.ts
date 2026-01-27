import crypto from "node:crypto";
import type { Decision } from "./decision";
import type { DecisionEvent } from "./events";

// -----------------------------
// Feature 14 — Decision Provenance Graph (chain)
// - deterministic under replay
// - cryptographically linked
// - stored in artifacts.extra.provenance (and artifacts.provenance for compat)
// -----------------------------

export type ProvenanceNode = {
  node_id: string;
  node_hash: string; // ✅ NEW: stored hash of this node (tamper-proof)
  
  seq: number;

  at: string;
  decision_id: string;

  event_type: string;
  actor_id: string | null;

  // hash of the applied event payload (sanitized)
  event_hash: string;

  // link to previous node
  prev_node_id: string | null;
  prev_node_hash: string | null;

  // hashes of decision states (sanitized)
  state_before_hash: string;
  state_after_hash: string;

  // optional debugging metadata (safe, small)
  meta?: Record<string, unknown> | null;
};

export type ProvenanceEdge = {
  from: string; // node_id
  to: string;   // node_id
  kind: "CAUSES" | "FORKED_FROM" | "MERGED_FROM" | "EVIDENCE" | "APPROVED_BY";
  meta?: Record<string, unknown> | null;
};

export type ProvenanceBag = {
  nodes: ProvenanceNode[];
  edges?: ProvenanceEdge[]; // ✅ NEW: DAG edges

  last_node_id: string | null;
  last_node_hash: string | null;

  // ✅ used to prevent duplicates / enforce 1-node-per-event
  last_history_len?: number | null;
};

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

function sanitizeDecisionForHash(d: Decision): any {
  const dd: any = d as any;

  const a: any = dd?.artifacts ?? {};
  const extra: any = a?.extra ?? {};

  const cleanArtifacts = {
    ...a,
    provenance: undefined, // compat
    extra: {
      ...extra,
      provenance: undefined, // canonical
    },
  };

  // ✅ normalize/strip timestamp fields that change with now() call count
  const cleanHistory = Array.isArray(dd?.history)
    ? dd.history.map((h: any) => {
        if (!h || typeof h !== "object") return h;
        const { at: _at, ...rest } = h; // drop history timestamps
        return rest;
      })
    : dd?.history;

  const {
    created_at: _created_at,
    updated_at: _updated_at,
    // (optional) if you have these in your Decision shape, strip them too:
    // evaluated_at: _evaluated_at,
    // last_evaluated_at: _last_evaluated_at,
    ...restDecision
  } = dd ?? {};

  return {
    ...restDecision,
    history: cleanHistory,
    artifacts: cleanArtifacts,
  };
}

function computeDecisionHash(d: Decision): string {
  return sha256Hex(stableStringify(sanitizeDecisionForHash(d)));
}

function normalizeBag(input: any): ProvenanceBag {
  const bag = input && typeof input === "object" ? input : {};
  const nodes = Array.isArray(bag.nodes) ? bag.nodes : [];
  const edges = Array.isArray(bag.edges) ? bag.edges : [];
  return {
    nodes,
    edges,
    last_node_id: typeof bag.last_node_id === "string" ? bag.last_node_id : null,
    last_node_hash: typeof bag.last_node_hash === "string" ? bag.last_node_hash : null,
    last_history_len: typeof bag.last_history_len === "number" ? bag.last_history_len : null,
  };
}



export function getProvenanceBag(decision: Decision): ProvenanceBag {
  const a: any = (decision as any)?.artifacts ?? {};
  const extra: any = a?.extra ?? {};
  // ✅ canonical-first
  return normalizeBag(extra.provenance ?? a.provenance);
}

export function setProvenanceBag(decision: Decision, bag: ProvenanceBag): Decision {
  const a: any = (decision as any)?.artifacts ?? {};
  const extra: any = a?.extra ?? {};

  // ✅ prevent shared-reference / circular issues
  const bagCompat = JSON.parse(JSON.stringify(bag));
  const bagCanon = JSON.parse(JSON.stringify(bag));

  return {
    ...(decision as any),
    artifacts: {
      ...a,
      provenance: bagCompat,                  // compat copy
      extra: { ...extra, provenance: bagCanon }, // canonical copy
    },
  } as any;
}

function computeNodeId(payload: any): string {
  // node_id must be stable under replay → derived from deterministic fields
  return sha256Hex(stableStringify(payload));
}

function computeNodeHash(node: ProvenanceNode): string {
  const { node_hash: _ignore, at: _at, ...rest } = node as any; // ✅ ignore at
  return sha256Hex(stableStringify(rest));
}

// ✅ Event hashing (sanitized + stable)
function sanitizeEventForHash(e: any): any {
  const ev = e && typeof e === "object" ? e : {};
  // Remove obviously non-deterministic fields if callers ever include them
  // (safe even if absent)
  const out: any = { ...ev };
  delete out.now;
  delete out.timestamp;
  delete out.created_at;
  delete out.updated_at;
  return out;
}

function computeEventHash(e: any): string {
  return sha256Hex(stableStringify(sanitizeEventForHash(e)));
}

function payloadForNodeId(x: {
  decision_id: any;
  seq: any;
  event_type: any;
  actor_id: any;
  event_hash: any;
  prev_node_id: any;
  prev_node_hash: any;
  state_before_hash: any;
  state_after_hash: any;
}) {
  return {
    decision_id: typeof x.decision_id === "string" ? x.decision_id : String(x.decision_id ?? "unknown"),
    seq: typeof x.seq === "number" ? x.seq : Number(x.seq ?? 0),
    event_type: typeof x.event_type === "string" ? x.event_type : String(x.event_type ?? "UNKNOWN"),
    actor_id: typeof x.actor_id === "string" ? x.actor_id : null,
    event_hash: typeof x.event_hash === "string" ? x.event_hash : String(x.event_hash ?? ""),
    prev_node_id: typeof x.prev_node_id === "string" ? x.prev_node_id : null,
    prev_node_hash: typeof x.prev_node_hash === "string" ? x.prev_node_hash : null,
    state_before_hash:
      typeof x.state_before_hash === "string" ? x.state_before_hash : String(x.state_before_hash ?? ""),
    state_after_hash:
      typeof x.state_after_hash === "string" ? x.state_after_hash : String(x.state_after_hash ?? ""),
  };
}


function isoToSecond(iso: string): string {
  const d = new Date(iso);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}


/**
 * Apply a provenance edge:
 * beforeDecision -> afterDecision, recording event application.
 *
 * seq rule:
 * - derived from afterDecision.history length (deterministic in replay)
 *
 * duplicate prevention:
 * - if bag.last_history_len already equals current history length,
 *   do NOT append another node (prevents double-append when applyDecisionEvent
 *   is called in layered flows)
 */
export function applyProvenanceTransition(input: {
  before: Decision;
  after: Decision;
  event: DecisionEvent | any;
  event_type: string;
  nowIso: string;
}): Decision {
  const before = input.before;
  const after = input.after;

  const bag0 = getProvenanceBag(after);
  const nodes0 = Array.isArray(bag0.nodes) ? bag0.nodes : [];

  const history = Array.isArray((after as any)?.history) ? (after as any).history : [];
  const historyLen = history.length;

  // ✅ Hard rule: 1 provenance node per history entry
  // If provenance already covers this history length (or beyond), do nothing.
  if (historyLen <= nodes0.length) {
    return after;
  }

  // ✅ If we jumped (replay from scratch / multi-append), only record the LAST transition.
  // This keeps output stable and prevents "VALIDATE/ADD_OBLIGATION repeating"
  const lastHistory = historyLen ? history[historyLen - 1] : null;
  const event_type = String(lastHistory?.type ?? input.event_type ?? "UNKNOWN");

  const atIso = isoToSecond(
    typeof (lastHistory as any)?.at === "string" && (lastHistory as any).at.length
      ? (lastHistory as any).at
      : input.nowIso
  );


  const seq = historyLen; // 1:1 with history length

  const actor_id =
    typeof lastHistory?.actor_id === "string"
      ? lastHistory.actor_id
      : typeof (input.event as any)?.actor_id === "string"
        ? (input.event as any).actor_id
        : null;

  const decision_id =
    typeof (after as any)?.decision_id === "string" ? (after as any).decision_id : "unknown";

  const state_before_hash = computeDecisionHash(before);
  const state_after_hash = computeDecisionHash(after);

  const lastNode = nodes0.length ? nodes0[nodes0.length - 1] : null;

  const prev_node_id =
    bag0.last_node_id ??
    (lastNode && typeof lastNode.node_id === "string" ? lastNode.node_id : null);

  const prev_node_hash =
    (lastNode && typeof (lastNode as any).node_hash === "string" ? (lastNode as any).node_hash : null) ??
    bag0.last_node_hash ??
    null;

  // ✅ event_hash from input.event is fine, but use history meta if you want.
  // Use the same fields you recorded into history (deterministic under replay)
    const event_hash = computeEventHash({
    type: event_type,
    actor_id,
    // include meta/reason if you want them to affect provenance identity
    meta: lastHistory?.meta ?? null,
    reason: (lastHistory as any)?.reason ?? null,
    });

  const nodePayloadForId = {
    decision_id,
    seq,
    event_type,
    actor_id,
    event_hash,
    prev_node_id,
    prev_node_hash,
    state_before_hash,
    state_after_hash,
  };

  const node_id = computeNodeId(nodePayloadForId);

  // build node WITHOUT node_hash first (no placeholder needed)
  const nodeNoHash = {
    node_id,
    seq,
    at: atIso,
    decision_id,
    event_type,
    actor_id,
    event_hash,
    prev_node_id,
    prev_node_hash,
    state_before_hash,
    state_after_hash,
    meta: null,
  } as Omit<ProvenanceNode, "node_hash">;

  // compute hash over contents (excluding node_hash)
  const node_hash = computeNodeHash({ ...(nodeNoHash as any), node_hash: "" } as any);

  // final node with stored node_hash
  const node: ProvenanceNode = {
    ...(nodeNoHash as any),
    node_hash,
  };

  const edges0 = Array.isArray((bag0 as any).edges) ? (bag0 as any).edges : [];
  const nextEdges = [...edges0];

  // ✅ Chain becomes a DAG with explicit edges (1 parent per node for now)
  if (prev_node_id) {
    nextEdges.push({ from: prev_node_id, to: node.node_id, kind: "CAUSES", meta: null });
  }

  const nextBag: ProvenanceBag = {
    nodes: [...nodes0, node],
    edges: nextEdges,
    last_node_id: node.node_id,
    last_node_hash: node.node_hash,
    last_history_len: historyLen,
  };

  return setProvenanceBag(after, nextBag);
}






export type ProvenanceVerifyResult =
  | { ok: true }
  | { ok: false; code: string; message: string; index?: number };

export function verifyProvenanceChain(decision: Decision): ProvenanceVerifyResult {
  const bag = getProvenanceBag(decision);
  const nodes = Array.isArray(bag.nodes) ? bag.nodes : [];

  // empty chain is valid
  if (nodes.length === 0) return { ok: true };

  let prevId: string | null = null;
  let prevHash: string | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as ProvenanceNode;

    // linkage checks
    if (i === 0) {
      if (n.prev_node_id !== null || n.prev_node_hash !== null) {
        return {
          ok: false,
          code: "BAD_GENESIS_LINK",
          message: "First provenance node must have null prev pointers.",
          index: i,
        };
      }
    } else {
      if (n.prev_node_id !== prevId) {
        return {
          ok: false,
          code: "BROKEN_PREV_ID",
          message: "Provenance prev_node_id does not match prior node_id.",
          index: i,
        };
      }
      if (n.prev_node_hash !== prevHash) {
        return {
          ok: false,
          code: "BROKEN_PREV_HASH",
          message: "Provenance prev_node_hash does not match prior node hash.",
          index: i,
        };
      }
    }

    // node_id integrity (recompute from deterministic payload fields)
    const expectedId = computeNodeId(
        payloadForNodeId({
            decision_id: n.decision_id,
            seq: n.seq,
            event_type: n.event_type,
            actor_id: n.actor_id,
            event_hash: (n as any).event_hash,
            prev_node_id: n.prev_node_id,
            prev_node_hash: n.prev_node_hash,
            state_before_hash: n.state_before_hash,
            state_after_hash: n.state_after_hash,
        })
    );

    if (n.node_id !== expectedId) {
      return {
        ok: false,
        code: "NODE_ID_MISMATCH",
        message: "Provenance node_id is not consistent with its payload.",
        index: i,
      };
    }

    // ✅ verify node_hash is consistent
    const expectedHash = computeNodeHash(n);
    if (n.node_hash !== expectedHash) {
        return {
            ok: false,
            code: "NODE_HASH_MISMATCH",
            message: "Provenance node_hash is not consistent with its contents.",
            index: i,
        };
    }

    // compute current node hash for next linkage
    prevId = n.node_id;
    prevHash = n.node_hash;
  }

  // last pointers should match bag
  if (bag.last_node_id !== prevId || bag.last_node_hash !== prevHash) {
    return {
      ok: false,
      code: "BAG_TAIL_MISMATCH",
      message: "Provenance bag tail does not match last computed node.",
      index: nodes.length - 1,
    };
  }

  return { ok: true };
}

export function migrateProvenanceChain(decision: Decision): Decision {
  const bag = getProvenanceBag(decision);
  const nodes = Array.isArray(bag.nodes) ? bag.nodes : [];
  if (nodes.length === 0) return decision;

  const migrated: ProvenanceNode[] = [];

  let prevId: string | null = null;
  let prevHash: string | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const n0: any = nodes[i] ?? {};

    const payload = payloadForNodeId({
        decision_id: n0.decision_id,
        seq: n0.seq,
        event_type: n0.event_type,
        actor_id: n0.actor_id,
        event_hash: n0.event_hash,
        prev_node_id: prevId,
        prev_node_hash: prevHash,
        state_before_hash: n0.state_before_hash,
        state_after_hash: n0.state_after_hash,
    });

    const node_id = computeNodeId(payload);

    const base: ProvenanceNode = {
      node_id,
      node_hash: "TEMP",
      seq: payload.seq,
      at: typeof n0.at === "string" && n0.at.length ? isoToSecond(n0.at) : "",
      decision_id: payload.decision_id,
      event_type: payload.event_type,
      actor_id: payload.actor_id,
      event_hash: payload.event_hash,
      prev_node_id: payload.prev_node_id,
      prev_node_hash: payload.prev_node_hash,
      state_before_hash: payload.state_before_hash,
      state_after_hash: payload.state_after_hash,
      meta: n0.meta ?? null,
    };

    const node_hash = computeNodeHash(base);

    const node: ProvenanceNode = { ...base, node_hash };
    migrated.push(node);

    prevId = node.node_id;
    prevHash = node.node_hash;
  }

  const nextBag: ProvenanceBag = {
    nodes: migrated,
    last_node_id: prevId,
    last_node_hash: prevHash,
    last_history_len:
      typeof bag.last_history_len === "number" ? bag.last_history_len : migrated.length,
  };

  return setProvenanceBag(decision, nextBag);
}

