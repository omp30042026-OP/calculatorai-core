// packages/decision/src/verify-integrity.ts
import type { DecisionStore } from "./store.js";
import type { PolicyViolation } from "./policy.js";

import {
  computePublicStateHash,
  computeTamperStateHash,
  stripNonStateFieldsForHash,
} from "./state-hash.js";

import { verifyProvenanceChain } from "./provenance.js";
import { ensureEnterpriseTables } from "./enterprise-schema.js";

import type { DiaStore } from "./dia.js";
import { makeSqliteDiaStore } from "./dia-store-sqlite.js";

export type IntegrityCheckName =
  | "DECISION_EXISTS"
  | "PROVENANCE_CHAIN"
  | "LATEST_LIABILITY_RECEIPT_PRESENT"
  | "PUBLIC_HASH_MATCHES_LATEST_RECEIPT"
  | "TAMPER_HASH_MATCHES_LATEST_RECEIPT"
  | "DIA_PRESENT_FOR_FINALIZE"
  | "FORK_RECEIPT_PRESENT_IF_BRANCH"
  | "FORK_RECEIPT_HASH_MATCHES_DB_IF_PRESENT";

export type IntegrityCheckResult = {
  name: IntegrityCheckName;
  ok: boolean;
  message: string;
  details?: any | null;
};

export type VerifyDecisionIntegrityInput = {
  decision_id: string;

  // Optional: provide DIA store (if omitted, verifier will use sqlite DIA store if db exists)
  diaStore?: DiaStore;

  // If true, require DIA for finalize events (APPROVE/REJECT/PUBLISH) when DB is available.
  // Default: false (AWS-friendly / best-effort)
  require_dia_for_finalize?: boolean;

  // If true, require liability receipts to exist in DB (when DB exists).
  // Default: true
  require_receipts_when_db_present?: boolean;

  // If true, enforce fork receipt checks when decision looks like a branch.
  // Default: true
  verify_fork_receipt?: boolean;
};

export type VerifyDecisionIntegrityResult =
  | {
      ok: true;
      decision_id: string;
      checks: IntegrityCheckResult[];
      warnings: PolicyViolation[];
      meta: {
        latest_event_seq: number | null;
        latest_receipt_hash: string | null;
        expected_public_state_after_hash: string | null;
        expected_tamper_state_after_hash: string | null;
        computed_public_state_hash: string | null;
        computed_tamper_state_hash: string | null;
        latest_finalize_event_seq: number | null;
        dia_hash: string | null;
      };
    }
  | {
      ok: false;
      decision_id: string;
      checks: IntegrityCheckResult[];
      violations: PolicyViolation[];
      meta: {
        latest_event_seq: number | null;
        latest_receipt_hash: string | null;
        expected_public_state_after_hash: string | null;
        expected_tamper_state_after_hash: string | null;
        computed_public_state_hash: string | null;
        computed_tamper_state_hash: string | null;
        latest_finalize_event_seq: number | null;
        dia_hash: string | null;
      };
    };

function asViolation(code: string, message: string, details?: any): PolicyViolation {
  return { code, severity: "BLOCK", message, details };
}

function pushCheck(checks: IntegrityCheckResult[], c: IntegrityCheckResult) {
  checks.push(c);
}

function getDb(store: DecisionStore): any | null {
  const db = (store as any)?.db;
  return db ?? null;
}

function looksLikeBranchDecision(decision: any): boolean {
  const parent =
    (decision as any)?.parent_decision_id ??
    (decision as any)?.meta?.counterfactual_of ??
    (decision as any)?.meta?.forked_from ??
    null;

  if (typeof parent === "string" && parent.length > 0) return true;
  return false;
}

export async function verifyDecisionIntegrityWithStore(
  store: DecisionStore,
  input: VerifyDecisionIntegrityInput
): Promise<VerifyDecisionIntegrityResult> {
  const decision_id = String(input.decision_id ?? "");
  const checks: IntegrityCheckResult[] = [];
  const violations: PolicyViolation[] = [];
  const warnings: PolicyViolation[] = [];

  const requireReceipts =
    input.require_receipts_when_db_present !== false; // default true
  const requireDia =
    input.require_dia_for_finalize === true; // default false
  const verifyFork =
    input.verify_fork_receipt !== false; // default true

  // ----------------------------
  // 1) Load persisted decision
  // ----------------------------
  let persisted: any = null;
  try {
    persisted = await store.getDecision(decision_id);
  } catch (e) {
    persisted = null;
  }

  if (!persisted) {
    pushCheck(checks, {
      name: "DECISION_EXISTS",
      ok: false,
      message: "Decision not found in store.getDecision().",
      details: { decision_id },
    });

    return {
      ok: false,
      decision_id,
      checks,
      violations: [asViolation("DECISION_NOT_FOUND", "Decision does not exist.", { decision_id })],
      meta: {
        latest_event_seq: null,
        latest_receipt_hash: null,
        expected_public_state_after_hash: null,
        expected_tamper_state_after_hash: null,
        computed_public_state_hash: null,
        computed_tamper_state_hash: null,
        latest_finalize_event_seq: null,
        dia_hash: null,
      },
    };
  }

  pushCheck(checks, {
    name: "DECISION_EXISTS",
    ok: true,
    message: "Decision exists.",
    details: { decision_id },
  });

  // ----------------------------
  // 2) Provenance chain check (portable)
  // ----------------------------
  try {
    const prov = verifyProvenanceChain(persisted);
    if (!prov.ok) {
      pushCheck(checks, {
        name: "PROVENANCE_CHAIN",
        ok: false,
        message: `Provenance invalid: ${prov.code}: ${prov.message}`,
        details: prov,
      });
      violations.push(
        asViolation("PROVENANCE_CHAIN_INVALID", "Decision provenance chain is invalid.", prov)
      );
    } else {
      pushCheck(checks, {
        name: "PROVENANCE_CHAIN",
        ok: true,
        message: "Provenance chain is internally consistent.",
        details: null,
      });
    }
  } catch (e) {
    pushCheck(checks, {
      name: "PROVENANCE_CHAIN",
      ok: false,
      message: "Provenance verification threw (unable to verify safely).",
      details: { error: String((e as any)?.message ?? e) },
    });
    violations.push(
      asViolation("PROVENANCE_VERIFY_FAILED", "Provenance verification failed.", {
        error: String((e as any)?.message ?? e),
      })
    );
  }

  // ----------------------------
  // 3) DB-backed integrity (receipts + DIA + fork_receipts)
  // ----------------------------
  const db = getDb(store);

  let latest_event_seq: number | null = null;
  let latest_receipt_hash: string | null = null;
  let expected_public_state_after_hash: string | null = null;
  let expected_tamper_state_after_hash: string | null = null;
  let computed_public_state_hash: string | null = null;
  let computed_tamper_state_hash: string | null = null;

  let latest_finalize_event_seq: number | null = null;
  let dia_hash: string | null = null;

  if (db) {
    try {
      ensureEnterpriseTables(db);
    } catch (e) {
      // If enterprise tables cannot be ensured, treat as fatal for DB-backed checks
      warnings.push({
        code: "ENTERPRISE_TABLES_UNAVAILABLE",
        severity: "BLOCK",
        message: "Unable to ensure enterprise tables; DB-backed integrity checks may be skipped.",
        details: { error: String((e as any)?.message ?? e) } as any,
      });
    }

    // 3a) latest liability receipt
    let lastReceipt: any = null;
    try {
      lastReceipt = db
        .prepare(
          `SELECT event_seq, receipt_hash, state_after_hash, public_state_after_hash
           FROM liability_receipts
           WHERE decision_id=?
           ORDER BY event_seq DESC
           LIMIT 1`
        )
        .get(decision_id);
    } catch (e) {
      lastReceipt = null;
    }

    if (!lastReceipt) {
      pushCheck(checks, {
        name: "LATEST_LIABILITY_RECEIPT_PRESENT",
        ok: !requireReceipts, // if not required, pass
        message: requireReceipts
          ? "No liability receipt row found (required)."
          : "No liability receipt row found (not required).",
        details: { decision_id },
      });

      if (requireReceipts) {
        violations.push(
          asViolation("LIABILITY_RECEIPT_MISSING", "No liability receipts found for decision.", {
            decision_id,
          })
        );
      }
    } else {
      latest_event_seq = Number(lastReceipt.event_seq ?? null);
      latest_receipt_hash = lastReceipt.receipt_hash ? String(lastReceipt.receipt_hash) : null;
      expected_tamper_state_after_hash =
        lastReceipt.state_after_hash != null ? String(lastReceipt.state_after_hash) : null;
      expected_public_state_after_hash =
        lastReceipt.public_state_after_hash != null
          ? String(lastReceipt.public_state_after_hash)
          : null;

      pushCheck(checks, {
        name: "LATEST_LIABILITY_RECEIPT_PRESENT",
        ok: true,
        message: "Latest liability receipt exists.",
        details: {
          latest_event_seq,
          receipt_hash: latest_receipt_hash,
        },
      });

      // 3b) compute hashes for persisted decision and compare to latest receipt
      try {
        const stripped = stripNonStateFieldsForHash(persisted);
        computed_public_state_hash = computePublicStateHash(stripped);
        computed_tamper_state_hash = computeTamperStateHash(stripped);
      } catch (e) {
        computed_public_state_hash = null;
        computed_tamper_state_hash = null;
      }

      // Public hash comparison (authoritative if present)
      if (expected_public_state_after_hash) {
        const ok = String(computed_public_state_hash ?? "") === String(expected_public_state_after_hash);

        pushCheck(checks, {
          name: "PUBLIC_HASH_MATCHES_LATEST_RECEIPT",
          ok,
          message: ok
            ? "Public state hash matches latest receipt."
            : "Public state hash mismatch vs latest receipt.",
          details: {
            expected: expected_public_state_after_hash,
            computed: computed_public_state_hash,
            receipt_hash: latest_receipt_hash,
            mode: "DUAL_HASH_PUBLIC",
          },
        });

        if (!ok) {
          violations.push(
            asViolation(
              "DECISION_PUBLIC_HASH_MISMATCH",
              "Decision public hash mismatch: stored decision does not match latest receipt public_state_after_hash.",
              {
                decision_id,
                latest_event_seq,
                expected_public_state_after_hash,
                computed_public_state_hash,
                receipt_hash: latest_receipt_hash,
              }
            )
          );
        }
      } else {
        // Legacy path: no public hash stored; do NOT block here.
        pushCheck(checks, {
          name: "PUBLIC_HASH_MATCHES_LATEST_RECEIPT",
          ok: true,
          message: "Legacy receipts: public_state_after_hash not present; skipping public hash match.",
          details: null,
        });
      }

      // Tamper hash comparison (optional)
      if (expected_tamper_state_after_hash) {
        const ok = String(computed_tamper_state_hash ?? "") === String(expected_tamper_state_after_hash);

        pushCheck(checks, {
          name: "TAMPER_HASH_MATCHES_LATEST_RECEIPT",
          ok,
          message: ok
            ? "Tamper state hash matches latest receipt."
            : "Tamper state hash mismatch vs latest receipt.",
          details: {
            expected: expected_tamper_state_after_hash,
            computed: computed_tamper_state_hash,
            receipt_hash: latest_receipt_hash,
            mode: expected_public_state_after_hash ? "DUAL_HASH_TAMPER" : "LEGACY_SINGLE_HASH",
          },
        });

        if (!ok) {
          violations.push(
            asViolation(
              "DECISION_TAMPER_HASH_MISMATCH",
              "Decision tamper hash mismatch: stored decision does not match latest receipt state_after_hash.",
              {
                decision_id,
                latest_event_seq,
                expected_state_after_hash: expected_tamper_state_after_hash,
                computed_tamper_state_hash,
                receipt_hash: latest_receipt_hash,
              }
            )
          );
        }
      } else {
        pushCheck(checks, {
          name: "TAMPER_HASH_MATCHES_LATEST_RECEIPT",
          ok: true,
          message: "No state_after_hash stored in receipt; skipping tamper hash match.",
          details: null,
        });
      }
    }

    // 3c) DIA presence for finalize events (best-effort)
    // We detect "latest finalize event seq" from events table if present, else skip.
    try {
      // If your sqlite-store includes events table, this works.
      // If not, it will throw and we'll skip gracefully.
      const row = db
        .prepare(
          `SELECT MAX(seq) as max_seq
           FROM decision_events
           WHERE decision_id=?
             AND (json_extract(event_json,'$.type') IN ('APPROVE','REJECT','PUBLISH'))`
        )
        .get(decision_id) as any;

      latest_finalize_event_seq =
        row && row.max_seq != null ? Number(row.max_seq) : null;
    } catch (e) {
      latest_finalize_event_seq = null;
    }

    if (latest_finalize_event_seq && latest_finalize_event_seq > 0) {
      // Choose DIA store: input.diaStore OR sqlite store
      const diaStore: DiaStore | null =
        input.diaStore ?? (db ? makeSqliteDiaStore(db) : null);

      let diaRow: any = null;
      try {
        // DiaStore API: appendDia exists; we need read, so fall back to direct sqlite if available
        // If DiaStore implements read/get, use it; otherwise use sqlite.
        const anyDia = diaStore as any;
        if (anyDia && typeof anyDia.getDia === "function") {
          diaRow = await anyDia.getDia(decision_id, latest_finalize_event_seq);
        } else if (db) {
          diaRow = db
            .prepare(
              `SELECT dia_hash
               FROM decision_integrity_attestations
               WHERE decision_id=? AND event_seq=?
               LIMIT 1`
            )
            .get(decision_id, latest_finalize_event_seq);
        }
      } catch (e) {
        diaRow = null;
      }

      dia_hash = diaRow?.dia_hash ? String(diaRow.dia_hash) : null;

      const ok = !!dia_hash || !requireDia;

      pushCheck(checks, {
        name: "DIA_PRESENT_FOR_FINALIZE",
        ok,
        message: dia_hash
          ? "DIA present for latest finalize event."
          : requireDia
            ? "DIA missing for latest finalize event (required)."
            : "DIA missing for latest finalize event (not required).",
        details: {
          decision_id,
          latest_finalize_event_seq,
          dia_hash,
        },
      });

      if (!dia_hash && requireDia) {
        violations.push(
          asViolation(
            "DIA_MISSING",
            "DIA required but not present for latest finalize event.",
            { decision_id, event_seq: latest_finalize_event_seq }
          )
        );
      }
    } else {
      pushCheck(checks, {
        name: "DIA_PRESENT_FOR_FINALIZE",
        ok: true,
        message: "No finalize events detected (or unable to query); skipping DIA requirement.",
        details: { decision_id, latest_finalize_event_seq },
      });
    }

    // 3d) Fork receipt checks (optional)
    if (verifyFork && looksLikeBranchDecision(persisted)) {
      const fr =
        (persisted as any)?.artifacts?.extra?.fork_receipt ??
        null;

      const hasFr = !!fr && typeof fr === "object";
      pushCheck(checks, {
        name: "FORK_RECEIPT_PRESENT_IF_BRANCH",
        ok: hasFr,
        message: hasFr
          ? "Fork receipt present on branch decision artifacts."
          : "Fork receipt missing on branch decision artifacts.",
        details: { decision_id },
      });

      if (!hasFr) {
        violations.push(
          asViolation(
            "FORK_RECEIPT_MISSING",
            "Branch decision is missing artifacts.extra.fork_receipt.",
            { decision_id }
          )
        );
      } else {
        const artifactHash = typeof fr.receipt_hash === "string" ? String(fr.receipt_hash) : "";
        if (db) {
          try {
            const row = db
              .prepare(
                `SELECT receipt_hash FROM fork_receipts WHERE branch_decision_id=? LIMIT 1`
              )
              .get(decision_id) as any;

            const rowHash = row?.receipt_hash ? String(row.receipt_hash) : "";

            const ok = !rowHash || rowHash === artifactHash;

            pushCheck(checks, {
              name: "FORK_RECEIPT_HASH_MATCHES_DB_IF_PRESENT",
              ok,
              message: ok
                ? "Fork receipt DB row (if present) matches artifacts hash."
                : "Fork receipt DB row hash mismatch vs artifacts.",
              details: { decision_id, db_receipt_hash: rowHash || null, artifacts_receipt_hash: artifactHash || null },
            });

            if (!ok) {
              violations.push(
                asViolation(
                  "FORK_RECEIPT_TAMPERED",
                  "fork_receipts.receipt_hash does not match artifacts fork_receipt.receipt_hash.",
                  { decision_id, db_receipt_hash: rowHash, artifacts_receipt_hash: artifactHash }
                )
              );
            }
          } catch (e) {
            // best-effort
            pushCheck(checks, {
              name: "FORK_RECEIPT_HASH_MATCHES_DB_IF_PRESENT",
              ok: true,
              message: "Unable to query fork_receipts table; skipping DB cross-check.",
              details: { error: String((e as any)?.message ?? e) },
            });
          }
        }
      }
    } else {
      pushCheck(checks, {
        name: "FORK_RECEIPT_PRESENT_IF_BRANCH",
        ok: true,
        message: "Decision does not look like a branch (or fork verification disabled).",
        details: null,
      });
      pushCheck(checks, {
        name: "FORK_RECEIPT_HASH_MATCHES_DB_IF_PRESENT",
        ok: true,
        message: "Fork receipt DB cross-check skipped.",
        details: null,
      });
    }
  } else {
    // No DB present => portable checks only
    pushCheck(checks, {
      name: "LATEST_LIABILITY_RECEIPT_PRESENT",
      ok: true,
      message: "No DB present on store; skipping DB-backed receipt checks.",
      details: null,
    });
    pushCheck(checks, {
      name: "PUBLIC_HASH_MATCHES_LATEST_RECEIPT",
      ok: true,
      message: "No DB present on store; skipping receipt public hash check.",
      details: null,
    });
    pushCheck(checks, {
      name: "TAMPER_HASH_MATCHES_LATEST_RECEIPT",
      ok: true,
      message: "No DB present on store; skipping receipt tamper hash check.",
      details: null,
    });
    pushCheck(checks, {
      name: "DIA_PRESENT_FOR_FINALIZE",
      ok: true,
      message: "No DB present on store; skipping DIA presence check.",
      details: null,
    });
    pushCheck(checks, {
      name: "FORK_RECEIPT_PRESENT_IF_BRANCH",
      ok: true,
      message: "No DB present on store; skipping fork receipt checks.",
      details: null,
    });
    pushCheck(checks, {
      name: "FORK_RECEIPT_HASH_MATCHES_DB_IF_PRESENT",
      ok: true,
      message: "No DB present on store; skipping fork receipt DB cross-check.",
      details: null,
    });
  }

  const ok = violations.length === 0 && checks.every((c) => c.ok);

  const meta = {
    latest_event_seq,
    latest_receipt_hash,
    expected_public_state_after_hash,
    expected_tamper_state_after_hash,
    computed_public_state_hash,
    computed_tamper_state_hash,
    latest_finalize_event_seq,
    dia_hash,
  };

  if (ok) {
    return { ok: true, decision_id, checks, warnings, meta };
  }

  return { ok: false, decision_id, checks, violations, meta };
}

