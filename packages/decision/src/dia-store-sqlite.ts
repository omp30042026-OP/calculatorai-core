// packages/decision/src/dia-store-sqlite.ts
import { computeDiaHashV1, type DiaStore } from "./dia.js";
import stableJson from "./stable-json.js";
const { stableStringify } = stableJson as any;


export function ensureDiaTables(db: any) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS decision_attestations (
      decision_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      dia_kind TEXT NOT NULL,
      dia_hash TEXT NOT NULL,
      dia_json TEXT NOT NULL,
      signature_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (decision_id, event_seq, dia_kind)
    );
  `).run();

  // ✅ Stronger: dia_hash should be globally unique (hash commits to decision_id+seq anyway)
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_decision_attestations_hash
    ON decision_attestations(dia_hash);
  `).run();

  // Optional: helps your common query pattern
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_decision_attestations_decision_seq
    ON decision_attestations(decision_id, event_seq);
  `).run();
}

/**
 * ✅ Finished feature: verify a stored DIA row is internally consistent.
 * - recompute hash from stored dia_json
 * - compare to stored dia_hash
 *
 * Returns { ok: true, row } or { ok: false, error }
 */
export function verifyStoredDiaRow(params: {
  db: any;
  decision_id: string;
  event_seq: number;
  dia_kind?: string; // default "DIA_V1"
}):
  | { ok: true; row: any; computed_hash: string }
  | { ok: false; error: string; row?: any } {
  const { db, decision_id, event_seq } = params;
  const dia_kind = params.dia_kind ?? "DIA_V1";

  ensureDiaTables(db);

  const row = db.prepare(`
    SELECT decision_id, event_seq, dia_kind, dia_hash, dia_json, signature_json, created_at
    FROM decision_attestations
    WHERE decision_id=? AND event_seq=? AND dia_kind=?
    LIMIT 1
  `).get(decision_id, event_seq, dia_kind) as any;

  if (!row) return { ok: false, error: "DIA_NOT_FOUND" };

  let diaObj: any = null;
  try {
    diaObj = JSON.parse(String(row.dia_json ?? "null"));
  } catch {
    return { ok: false, error: "DIA_JSON_INVALID", row };
  }

  let computed: string;
  try {
    computed = computeDiaHashV1(diaObj);
  } catch (e) {
    return { ok: false, error: `DIA_HASH_RECOMPUTE_FAILED: ${String((e as any)?.message ?? e)}`, row };
  }

  const stored = String(row.dia_hash ?? "");
  if (!stored) return { ok: false, error: "DIA_HASH_MISSING", row };

  if (stored !== computed) {
    return {
      ok: false,
      error: `DIA_TAMPERED: stored=${stored} computed=${computed}`,
      row,
    };
  }

  return { ok: true, row, computed_hash: computed };
}

export function makeSqliteDiaStore(db: any): DiaStore {
  return {
    appendDia: async (row) => {
      ensureDiaTables(db);
      if (row.dia_kind !== "DIA_V1") {
        throw new Error(`DIA_KIND_UNSUPPORTED: ${String(row.dia_kind)}`);
      }

      // ✅ Store deterministic JSON (stable order) to minimize drift across runs.
      const dia_json = stableStringify(row.dia_json ?? null);
      const sig_json =
        row.signature_json == null ? null : stableStringify(row.signature_json);

      // ✅ Idempotent insert
      db.prepare(`
        INSERT OR IGNORE INTO decision_attestations(
          decision_id, event_seq, dia_kind, dia_hash, dia_json, signature_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.decision_id,
        row.event_seq,
        row.dia_kind,
        row.dia_hash,
        dia_json,
        sig_json,
        row.created_at
      );

      // ✅ Read back and enforce:
      // 1) dia_hash matches
      // 2) stored dia_json recomputes to dia_hash (internal integrity)
      const existing = db.prepare(`
        SELECT dia_hash, dia_json
        FROM decision_attestations
        WHERE decision_id=? AND event_seq=? AND dia_kind=?
        LIMIT 1
      `).get(row.decision_id, row.event_seq, row.dia_kind) as any;

      if (!existing) {
        throw new Error("DIA_WRITE_FAILED: row missing after insert");
      }

      const storedHash = existing?.dia_hash ? String(existing.dia_hash) : "";
      if (storedHash && storedHash !== String(row.dia_hash)) {
        throw new Error(
          `DIA_CONFLICT: stored=${storedHash} computed=${String(row.dia_hash)}`
        );
      }

      // ✅ recompute from stored dia_json (detect DB tamper even if someone edited dia_json only)
      try {
        const storedObj = JSON.parse(String(existing.dia_json ?? "null"));
        const recomputed = computeDiaHashV1(storedObj);

        if (String(recomputed) !== String(row.dia_hash)) {
          throw new Error(
            `DIA_TAMPERED: stored_json_hash=${recomputed} expected=${String(row.dia_hash)}`
          );
        }
      } catch (e) {
        throw new Error(
          `DIA_VERIFY_FAILED: ${String((e as any)?.message ?? e)}`
        );
      }
    },
  };
}
