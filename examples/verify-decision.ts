import Database from "better-sqlite3";

import {
  stripNonStateFieldsForHash,
  computePublicStateHash,
  computeTamperStateHash,
} from "../packages/decision/src/liability-hash.js";

function nowIso() {
  return new Date().toISOString();
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function hasColumn(raw: Database.Database, table: string, col: string): boolean {
  try {
    const rows = raw.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function must(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

function safeJsonParse(s: string, label: string) {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

type VerifyResult = {
  ok: boolean;
  decision_id: string;
  checks: Record<string, { ok: boolean; details?: any }>;
  summary: {
    state?: string;
    amount_value?: number | null;
    amount_currency?: string | null;
    receipts_count?: number;
    latest_event_seq?: number;
    latest_event_type?: string | null;
    latest_state_after_hash?: string | null;

    // ✅ NEW
    public_state_after_hash?: string | null;

    approve_signer_state_hash?: string | null;
    simulate_state_after_hash?: string | null;
    verified_at: string;
    };
};

function computeWorkflowSatisfied(decision: any, eventTypes: string[]) {
  // Matches your workflow template:
  // s1_require_amount: REQUIRE_FIELD "amount"
  // s2_require_validate: REQUIRE_EVENT "VALIDATE"
  // s3_require_approve_or_reject: REQUIRE_EVENT ["APPROVE","REJECT"]

  const getAmount = () => {
    return (
      decision?.amount ??
      decision?.fields?.amount ??
      decision?.artifacts?.amount ??
      decision?.artifacts?.extra?.amount ??
      null
    );
  };

  const amt = getAmount();
  const amountOk =
    amt != null &&
    (typeof amt !== "object"
      ? true
      : (amt?.value != null && Number.isFinite(Number(amt.value))) ||
        Object.keys(amt ?? {}).length > 0);

  const validateOk = eventTypes.includes("VALIDATE");
  const approveOrRejectOk = eventTypes.includes("APPROVE") || eventTypes.includes("REJECT");

  return {
    s1_require_amount: amountOk,
    s2_require_validate: validateOk,
    s3_require_approve_or_reject: approveOrRejectOk,
    is_complete: amountOk && validateOk && approveOrRejectOk,
    amount: amt,
  };
}

function extractSignerStateHash(decision: any, approveEventJson?: any): string | null {
  // Prefer event_json meta if provided; otherwise fall back to decision.history
  const fromEvent = approveEventJson?.meta?.signer_state_hash;
  if (typeof fromEvent === "string" && fromEvent.length > 0) return fromEvent;

  const hist = Array.isArray(decision?.history) ? decision.history : [];
  const approve = hist.find((h: any) => h?.type === "APPROVE");
  const fromHist = approve?.meta?.signer_state_hash;
  if (typeof fromHist === "string" && fromHist.length > 0) return fromHist;

  return null;
}

function writeExport(path: string, payload: any) {
  // avoid adding deps; node fs is fine
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs");
  fs.writeFileSync(path, JSON.stringify(payload, null, 2));
}

function main() {
  const dbPath = arg("--db") ?? "replay-demo.db";
  const decision_id = arg("--decision") ?? "dec_exec_001";
  const exportPath = arg("--export"); // optional

  const raw = new Database(dbPath);

  const checks: VerifyResult["checks"] = {};

  // ---- decision_json ----
  const drow = raw
    .prepare(`SELECT decision_json FROM decisions WHERE decision_id=?`)
    .get(decision_id) as { decision_json?: string } | undefined;

  must(drow?.decision_json, `Decision not found in decisions table: ${decision_id}`);

  const decision = safeJsonParse(String(drow!.decision_json), "decisions.decision_json");

  checks.decision_exists = { ok: true };

  // ---- receipts ----
  const receipts = raw
    .prepare(`SELECT * FROM liability_receipts WHERE decision_id=? ORDER BY event_seq ASC`)
    .all(decision_id) as any[];

  checks.receipts_exist = { ok: receipts.length > 0, details: { count: receipts.length } };

  // ---- decision_events types ----
  const eventRows = raw
    .prepare(
      `SELECT seq, json_extract(event_json,'$.type') AS type, event_json
       FROM decision_events
       WHERE decision_id=?
       ORDER BY seq ASC`
    )
    .all(decision_id) as Array<{ seq: number; type: string; event_json: string }>;

  const eventTypes = eventRows.map((r) => String(r.type || "")).filter(Boolean);

  checks.events_exist = { ok: eventRows.length > 0, details: { count: eventRows.length } };

  // ---- Workflow completeness (Feature 16 part A) ----
  const wf = computeWorkflowSatisfied(decision, eventTypes);
  checks.workflow_complete = {
    ok: wf.is_complete,
    details: { satisfied_steps: { ...wf } },
  };

  // ---- Receipt chain integrity (best-effort) ----
  // Some schemas have prev_hash/hash; we verify if present.
  const hasPrev = hasColumn(raw, "liability_receipts", "prev_hash");
  const hasHash = hasColumn(raw, "liability_receipts", "hash");

  let chainOk = true;
  let chainProblems: any[] = [];

  // Always verify event_seq is contiguous ascending starting at 1 (best effort).
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const expectedSeq = i + 1;
    if (Number(r.event_seq) !== expectedSeq) {
      chainOk = false;
      chainProblems.push({
        kind: "SEQ_GAP",
        at_index: i,
        expected_event_seq: expectedSeq,
        got_event_seq: r.event_seq,
      });
    }

    if (hasPrev && hasHash && i > 0) {
      const prev = receipts[i - 1];
      if (String(r.prev_hash || "") !== String(prev.hash || "")) {
        chainOk = false;
        chainProblems.push({
          kind: "HASH_LINK_MISMATCH",
          event_seq: r.event_seq,
          expected_prev_hash: prev.hash,
          got_prev_hash: r.prev_hash,
        });
      }
    }
  }

  checks.receipt_chain_ok = {
    ok: receipts.length > 0 ? chainOk : false,
    details: {
      schema: { has_prev_hash: hasPrev, has_hash: hasHash },
      problems: chainProblems,
    },
  };

  // ---- PLS binding check (Feature 16 part B) ----
  // Rule: APPROVE.meta.signer_state_hash must equal SIMULATE receipt state_after_hash
  const simulateReceipt = [...receipts].reverse().find((r) => r.event_type === "SIMULATE") ?? null;
  const approveReceipt = [...receipts].reverse().find((r) => r.event_type === "APPROVE") ?? null;

  // Try to get APPROVE event_json too (more reliable than history sometimes)
  const approveEventRow = [...eventRows].reverse().find((r) => r.type === "APPROVE") ?? null;
  const approveEventJson = approveEventRow
    ? safeJsonParse(String(approveEventRow.event_json), "decision_events.event_json(APPROVE)")
    : null;

  const signer_state_hash = extractSignerStateHash(decision, approveEventJson);
  const simulate_state_after_hash = simulateReceipt?.state_after_hash
    ? String(simulateReceipt.state_after_hash)
    : null;

  const plsOk =
    signer_state_hash != null &&
    simulate_state_after_hash != null &&
    signer_state_hash === simulate_state_after_hash;

  checks.pls_binding_ok = {
    ok: plsOk,
    details: {
      signer_state_hash,
      simulate_state_after_hash,
      hint:
        plsOk
          ? "OK"
          : "Expected APPROVE.meta.signer_state_hash to equal SIMULATE.state_after_hash",
    },
  };

      // ---- Feature 17: canonical decision hash verification vs latest receipt ----
  // We compute the SAME canonical hash views as store-engine writes into liability_receipts.
  const latestReceipt = receipts.length ? receipts[receipts.length - 1] : null;
  const latestEvent = eventRows.length ? eventRows[eventRows.length - 1] : null;

  const seqOk =
    latestReceipt?.event_seq != null &&
    latestEvent?.seq != null &&
    Number(latestReceipt.event_seq) === Number(latestEvent.seq);

  // Canonical receipt view (must match store-engine’s strip)
  const decisionForHash = stripNonStateFieldsForHash(decision);

  // Compute canonical hash families
  const computed_public_state_hash = computePublicStateHash(decisionForHash);
  const computed_tamper_state_hash = computeTamperStateHash(decisionForHash);

  // Expected from latest receipt (may be legacy DBs with no public column populated)
  const expected_public_state_after_hash =
    latestReceipt?.public_state_after_hash != null
      ? String(latestReceipt.public_state_after_hash)
      : null;

  const expected_tamper_state_after_hash =
    latestReceipt?.state_after_hash != null ? String(latestReceipt.state_after_hash) : null;

  const isLegacySingleHash = !expected_public_state_after_hash;

  let hashOk = true;
  let hashMode: string = "DUAL_HASH_PUBLIC";
  let hashProblems: any[] = [];

  if (!latestReceipt) {
    hashOk = false;
    hashProblems.push({ kind: "NO_RECEIPTS" });
  } else if (isLegacySingleHash) {
    // Legacy: only state_after_hash is available. Try matching with both modern candidates.
    hashMode = "LEGACY_SINGLE_HASH";

    const candidates: Array<{ mode: string; hash: string }> = [];
    try {
      candidates.push({ mode: "LEGACY_TAMPER_V_CURRENT", hash: computed_tamper_state_hash });
    } catch {}
    try {
      candidates.push({ mode: "LEGACY_PUBLIC_V_CURRENT", hash: computed_public_state_hash });
    } catch {}

    if (!expected_tamper_state_after_hash) {
      hashOk = true; // nothing to check
    } else {
      const ok = candidates.some((c) => String(c.hash) === String(expected_tamper_state_after_hash));
      if (!ok) {
        hashOk = false;
        hashProblems.push({
          kind: "DECISION_TAMPERED_LEGACY",
          expected_state_after_hash: expected_tamper_state_after_hash,
          computed_candidates: candidates,
        });
      }
    }
  } else {
    // Dual-hash: public hash is authoritative
    hashMode = "DUAL_HASH_PUBLIC";

    if (String(computed_public_state_hash) !== String(expected_public_state_after_hash)) {
      hashOk = false;
      hashProblems.push({
        kind: "DECISION_PUBLIC_HASH_MISMATCH",
        expected_public_state_after_hash,
        computed_public_state_hash,
      });
    }

    // Optional: also verify tamper hash if present in receipt
    if (expected_tamper_state_after_hash) {
      if (String(computed_tamper_state_hash) !== String(expected_tamper_state_after_hash)) {
        hashOk = false;
        hashProblems.push({
          kind: "DECISION_TAMPER_HASH_MISMATCH",
          expected_state_after_hash: expected_tamper_state_after_hash,
          computed_tamper_state_hash,
        });
      }
    }
  }

  checks.latest_seq_alignment = {
    ok: !!seqOk,
    details: {
      latest_receipt_event_seq: latestReceipt?.event_seq ?? null,
      latest_event_seq: latestEvent?.seq ?? null,
    },
  };

  checks.decision_hash_matches_latest_receipt = {
    ok: hashOk,
    details: {
      mode: hashMode,
      latest_event_seq: latestReceipt?.event_seq ?? null,
      latest_event_type: latestReceipt?.event_type ?? null,
      expected_public_state_after_hash,
      expected_tamper_state_after_hash,
      computed_public_state_hash,
      computed_tamper_state_hash,
      problems: hashProblems,
    },
  };

  const amount = wf.amount;
  const amount_value =
    amount && typeof amount === "object" && amount.value != null ? Number(amount.value) : null;
  const amount_currency =
    amount && typeof amount === "object" && amount.currency != null
      ? String(amount.currency)
      : null;

  const result: VerifyResult = {
    ok: Object.values(checks).every((c) => c.ok === true),
    decision_id,
    checks,
    summary: {
      state: decision?.state ?? null,
      amount_value,
      amount_currency,
      receipts_count: receipts.length,
      latest_event_seq: latestReceipt?.event_seq ?? null,
      latest_event_type: latestReceipt?.event_type ?? null,
      latest_state_after_hash: latestReceipt?.state_after_hash ?? null,
      public_state_after_hash: latestReceipt?.public_state_after_hash ?? null,
      approve_signer_state_hash: signer_state_hash,
      simulate_state_after_hash,
      verified_at: nowIso(),
    },
  };

  if (exportPath) {
    writeExport(exportPath, result);
    console.log(`[VERIFY] exported proof -> ${exportPath}`);
  }

  console.log(JSON.stringify(result, null, 2));
  raw.close();

  process.exit(result.ok ? 0 : 2);
}

main();

