// packages/decision/__tests__/dia.sqlite.test.ts
import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { computeDiaHashV1 } from "../src/dia.js";
import { ensureDiaTables, verifyStoredDiaRow } from "../src/dia-store-sqlite.js";
import { stableStringify } from "../src/stable-json.js";

describe("DIA sqlite", () => {
  test("stores DIA, verifies hash, detects tamper", () => {
    const db = new Database(":memory:");
    ensureDiaTables(db);

    const dia = {
      kind: "DIA_V1",
      decision_id: "dec_dia_test_001",
      event_seq: 3,
      finalize_event_type: "APPROVE",
      made_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      actor: { actor_id: "u1", actor_type: "human", roles: [] },
      integrity: {
        liability_receipt_hash: "x",
        obligations_hash: "y",
        public_state_hash: "p",
        tamper_state_hash: "t",
      },
      lineage: { fork_receipt_hash: null, parent_decision_id: null },
      notes: null,
    };

    const dia_hash = computeDiaHashV1(dia as any);
    const dia_json = stableStringify(dia);

    db.prepare(
      `INSERT INTO decision_attestations
       (decision_id,event_seq,dia_kind,dia_hash,dia_json,signature_json,created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      dia.decision_id,
      dia.event_seq,
      "DIA_V1",
      dia_hash,
      dia_json,
      null,
      new Date().toISOString()
    );

    const v1 = verifyStoredDiaRow({ db, decision_id: dia.decision_id, event_seq: dia.event_seq });
    expect(v1.ok).toBe(true);

    // tamper the json payload
    db.prepare(
      `UPDATE decision_attestations
       SET dia_json='{"kind":"DIA_V1","tampered":true}'
       WHERE decision_id=? AND event_seq=? AND dia_kind='DIA_V1'`
    ).run(dia.decision_id, dia.event_seq);

    const v2 = verifyStoredDiaRow({ db, decision_id: dia.decision_id, event_seq: dia.event_seq });
    expect(v2.ok).toBe(false);
  });
});

