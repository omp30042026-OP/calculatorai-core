import Database from "better-sqlite3";

// ✅ local monorepo imports
import { replayDecision } from "./packages/decision/src/engine.js";
import { createDecisionV2 } from "./packages/decision/src/decision.js";
import { computeDecisionStateHash } from "./packages/decision/src/state-hash.js";
import { applyProvenanceTransition, migrateProvenanceChain } from "./packages/decision/src/provenance.js";

const db = new Database("replay-demo.db");
const decision_id = "dec_exec_001";

function clone(x: any) { return JSON.parse(JSON.stringify(x)); }

function sha256Hex(s: string) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// legacy-style stable stringify (sorted keys)
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
      const vv = (v as any)[k];
      if (typeof vv === "undefined") continue;
      out[k] = norm(vv);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

// --- build genesis-clean DRAFT root (matches store-engine canonicalDraftRootFromStored) ---
const rootRow: any = db
  .prepare("SELECT decision_json FROM decisions WHERE decision_id=?")
  .get(decision_id);

const persistedRoot = JSON.parse(rootRow.decision_json);
const created_at = persistedRoot.created_at ?? "1970-01-01T00:00:00.000Z";
const nowFn = () => created_at;

const genesis: any = createDecisionV2(
  { decision_id, meta: persistedRoot.meta ?? {}, artifacts: {}, version: 1 } as any,
  nowFn
);
genesis.state = "DRAFT";
genesis.created_at = created_at;
genesis.updated_at = created_at;

// load events + at timestamps
const rows: any[] = db.prepare(`
  SELECT seq, at, event_json
  FROM decision_events
  WHERE decision_id=?
  ORDER BY seq
`).all(decision_id);

const events = rows.map(r => ({
  seq: Number(r.seq),
  at: String(r.at),
  event: JSON.parse(r.event_json),
}));

// Reconstruct EXACT persisted decision used by receipts: replay + provenance + PLS injection
function buildToPersist(prev: any, nextFromReplay: any, event: any, event_type: string, at: string, seq: number) {
  const before = migrateProvenanceChain(prev);
  const after = nextFromReplay;

  const withProv = applyProvenanceTransition({
    before,
    after,
    event,
    event_type,
    nowIso: at,          // ✅ use event.at so it matches receipts timeline
  });

  // ✅ mimic store-engine withPLS injection (it’s unconditional in your code)
  const withPLS = {
    ...(withProv as any),
    artifacts: {
      ...((withProv as any).artifacts ?? {}),
      extra: {
        ...(((withProv as any).artifacts?.extra ?? {}) as any),
        liability_shield: {
          at,
          decision_id,
          event_type,
          event_seq: seq,
          responsibility: null,
          approver: null,
          impact: null,
          signer_state_hash: (event?.meta?.signer_state_hash ?? null),
        },
      },
    },
  };

  return withPLS;
}

// Candidate legacy projections (we’ll discover what old receipts hashed)
function legacyProjection(dec: any, mode: string) {
  const d = clone(dec);

  if (mode === "FULL") {
    return computeDecisionStateHash(d);
  }

  // stable-ish strips that legacy might have used
  delete d.updated_at; delete d.created_at; delete d.deleted_at; delete d.archived_at; delete d.version;
  delete d.execution; delete d.signatures;

  if (mode === "STRIP_META") delete d.meta;
  if (mode === "STRIP_META_TAMPERED_ONLY") { if (d.meta) delete d.meta.tampered; }

  if (mode === "STRIP_RISK_ACC") { delete d.risk; delete d.accountability; }

  if (mode === "STRIP_ARTIFACTS_EXTRA") { if (d.artifacts?.extra) delete d.artifacts.extra; }

  if (mode === "STRIP_ALL") {
    delete d.meta; delete d.risk; delete d.accountability;
    if (d.artifacts?.extra) delete d.artifacts.extra;
  }

  return computeDecisionStateHash(d);
}

// Also try *raw sha256(stableStringify(...))* in case legacy used that directly
function rawStableSha(dec: any) {
  return sha256Hex(stableStringify(dec));
}

const modes = [
  "FULL",
  "STRIP_META",
  "STRIP_META_TAMPERED_ONLY",
  "STRIP_RISK_ACC",
  "STRIP_ARTIFACTS_EXTRA",
  "STRIP_ALL",
];

let prev = genesis;

for (const e of events) {
  const upto = events.filter(x => x.seq <= e.seq).map(x => x.event);

  const rr: any = replayDecision(genesis, upto, {
    allow_locked_event_types: ["ATTACH_ARTIFACTS", "INGEST_RECORDS", "ATTEST_EXTERNAL"],
  } as any);

  if (rr.ok === false) {
    console.log("\nseq", e.seq, "replay FAILED");
    continue;
  }

  const rec: any = db.prepare(`
    SELECT state_after_hash, public_state_after_hash, event_type
    FROM liability_receipts
    WHERE decision_id=? AND event_seq=?
  `).get(decision_id, e.seq);

  const expected = String(rec?.state_after_hash ?? "");
  const evType = String(rec?.event_type ?? "");

  // ✅ reconstruct store-engine persisted head for this seq
  const toPersist = buildToPersist(prev, rr.decision, e.event, evType, e.at, e.seq);

  const candidates: [string,string][] = [];
  for (const m of modes) candidates.push([`legacy_${m}`, legacyProjection(toPersist, m)]);
  candidates.push(["rawStableSha(toPersist)", rawStableSha(toPersist)]);

  const hit = candidates.find(([_, h]) => h === expected);

  console.log(`\nseq ${e.seq} (${evType}) expected=${expected.slice(0, 12)}`);
  if (hit) console.log("  ✅ MATCH:", hit[0], hit[1]);
  else {
    console.log("  ❌ no match; candidates:");
    for (const [name, h] of candidates) console.log("   ", name, h.slice(0, 12));
  }

  // ✅ advance prev as store-engine would (persisted head after this event)
  prev = toPersist;
}
