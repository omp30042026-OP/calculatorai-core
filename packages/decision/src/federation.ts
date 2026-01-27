import crypto from "crypto";
import type { LedgerSigner, LedgerVerifier } from "./ledger-signing.js";
import type { LedgerEntry } from "./ledger.js";
import { SqliteDecisionLedgerStore } from "./sqlite-ledger-store.js";

export type FederationStatus = "PROPOSED" | "CO_SIGNED" | "DISPUTED";

export type FederationEvent = {
  federation_id: string;        // stable id (e.g. "FED_001")
  at: string;                   // iso
  purpose: string;              // e.g. "CHARGEBACK_EVIDENCE", "DELIVERY_CONFIRMATION"
  payload: any;                 // domain event
  payload_hash: string;         // sha256(canonical payload)
  tenant_a: string;
  tenant_b: string;
  status: FederationStatus;
  a_sig?: { sig_alg: string | null; key_id: string | null; sig: string | null };
  b_sig?: { sig_alg: string | null; key_id: string | null; sig: string | null };
  challenged?: { at: string; by_tenant: string; reason: string } | null;
};

function stableStringify(x: any): string {
  // deterministic JSON (good enough for demo): recursively sort keys
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const keys = Object.keys(x).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(x[k])).join(",")}}`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function computeFederationPayloadHash(payload: any): string {
  return sha256Hex(stableStringify(payload));
}

export function computeFederationEventHash(e: {
  federation_id: string;
  at: string;
  purpose: string;
  payload_hash: string;
  tenant_a: string;
  tenant_b: string;
}): string {
  return sha256Hex(
    stableStringify({
      federation_id: e.federation_id,
      at: e.at,
      purpose: e.purpose,
      payload_hash: e.payload_hash,
      tenant_a: e.tenant_a,
      tenant_b: e.tenant_b,
    })
  );
}

export type CreateFederationInput = {
  federation_id: string;
  at: string;
  purpose: string;
  payload: any;
  tenant_a: string;
  tenant_b: string;
  signerA: LedgerSigner;
};

export type CosignFederationInput = {
  federation_id: string;
  tenant_b: string;
  signerB: LedgerSigner;
};

export type ChallengeFederationInput = {
  federation_id: string;
  by_tenant: string;
  reason: string;
  at: string;
};

export type VerifyFederationOptions = {
  resolveVerifier: (parts: { tenant_id: string; key_id: string }) => LedgerVerifier | null;
};

export class FederationStore {
  constructor(private ledger: SqliteDecisionLedgerStore) {}

  /**
   * Feature 19 (v1): Create a federation event and sign it by tenant A.
   * Writes to ledger as FEDERATION_EVENT_PROPOSED
   */
  async createFederationEvent(input: CreateFederationInput): Promise<FederationEvent> {
    const payload_hash = computeFederationPayloadHash(input.payload);
    const event_hash = computeFederationEventHash({
      federation_id: input.federation_id,
      at: input.at,
      purpose: input.purpose,
      payload_hash,
      tenant_a: input.tenant_a,
      tenant_b: input.tenant_b,
    });

    const entry = await this.ledger.appendLedgerEntry({
      at: input.at,
      tenant_id: input.tenant_a,
      type: "FEDERATION_EVENT_PROPOSED" as any,
      decision_id: input.federation_id,
      event_seq: 1,
      snapshot_up_to_seq: null,
      anchor_seq: null,
      payload: {
        federation_id: input.federation_id,
        purpose: input.purpose,
        payload: input.payload,
        payload_hash,
        event_hash,
        tenant_a: input.tenant_a,
        tenant_b: input.tenant_b,
        status: "PROPOSED",
      },
      signer: input.signerA,
    } as any);

    return ledgerEntryToFederationEvent(entry);
  }

  /**
   * Feature 19 (v1): Tenant B countersigns the same federation event hash.
   * Writes to ledger as FEDERATION_EVENT_COSIGNED
   */
  async cosignFederationEvent(input: CosignFederationInput): Promise<FederationEvent> {
    const proposed = await this.getLatestFederationState(input.federation_id);
    if (!proposed) throw new Error("FEDERATION_NOT_FOUND");
    if (proposed.status === "DISPUTED") throw new Error("FEDERATION_DISPUTED_LOCKED");
    if (proposed.tenant_b !== input.tenant_b) throw new Error("TENANT_B_MISMATCH");
    if (proposed.status === "CO_SIGNED") return proposed;

    const entry = await this.ledger.appendLedgerEntry({
      at: new Date().toISOString(),
      tenant_id: input.tenant_b,
      type: "FEDERATION_EVENT_COSIGNED" as any,
      decision_id: input.federation_id,
      event_seq: 2,
      snapshot_up_to_seq: null,
      anchor_seq: null,
      payload: {
        federation_id: proposed.federation_id,
        purpose: proposed.purpose,
        payload: proposed.payload,
        payload_hash: proposed.payload_hash,
        event_hash: computeFederationEventHash({
          federation_id: proposed.federation_id,
          at: proposed.at,
          purpose: proposed.purpose,
          payload_hash: proposed.payload_hash,
          tenant_a: proposed.tenant_a,
          tenant_b: proposed.tenant_b,
        }),
        tenant_a: proposed.tenant_a,
        tenant_b: proposed.tenant_b,
        status: "CO_SIGNED",
      },
      signer: input.signerB,
    } as any);

    return ledgerEntryToFederationEvent(entry);
  }

  /**
   * Feature 20 (v1): Challenge -> freezes the event (no further mutation allowed).
   * Writes to ledger as FEDERATION_EVENT_CHALLENGED
   */
  async challengeFederationEvent(input: ChallengeFederationInput): Promise<FederationEvent> {
    const cur = await this.getLatestFederationState(input.federation_id);
    if (!cur) throw new Error("FEDERATION_NOT_FOUND");
    if (cur.status === "DISPUTED") return cur;

    const entry = await this.ledger.appendLedgerEntry({
      at: input.at,
      tenant_id: input.by_tenant,
      type: "FEDERATION_EVENT_CHALLENGED" as any,
      decision_id: input.federation_id,
      event_seq: 3,
      snapshot_up_to_seq: null,
      anchor_seq: null,
      payload: {
        federation_id: cur.federation_id,
        purpose: cur.purpose,
        payload: cur.payload,
        payload_hash: cur.payload_hash,
        tenant_a: cur.tenant_a,
        tenant_b: cur.tenant_b,
        status: "DISPUTED",
        challenged: { at: input.at, by_tenant: input.by_tenant, reason: input.reason },
      },
    } as any);

    return ledgerEntryToFederationEvent(entry);
  }

  /**
   * Export a proof bundle that a third party can verify offline.
   */
  async exportFederationProofBundle(federation_id: string) {
    const entries = await this.ledger.listLedgerEntries({ limit: 1_000_000 });
    const fedEntries = entries.filter((e) => e.decision_id === federation_id);

    const bundle = {
      kind: "VERITASCALE_FEDERATION_PROOF_BUNDLE_V1",
      generated_at: new Date().toISOString(),
      federation_id,
      from_seq: fedEntries.length ? fedEntries[0]!.seq : null,
      to_seq: fedEntries.length ? fedEntries[fedEntries.length - 1]!.seq : null,
      ledger_entries: fedEntries,
    };

    return bundle;
  }

  /**
   * Verify a proof bundle:
   * - ledger chain integrity for included entries
   * - signatures for entries that include sigs
   * - reconstruct latest federation state from the included entries
   */
  verifyFederationBundle(
    bundle: any,
    opts: VerifyFederationOptions
  ): { ok: boolean; errors: any[]; state: FederationEvent | null } {
    const errors: any[] = [];

    if (!bundle || bundle.kind !== "VERITASCALE_FEDERATION_PROOF_BUNDLE_V1") {
      return { ok: false, errors: [{ code: "BUNDLE_KIND_INVALID" }], state: null };
    }

    const entries: LedgerEntry[] = bundle.ledger_entries ?? [];
    if (!Array.isArray(entries) || entries.length === 0) {
      return { ok: false, errors: [{ code: "BUNDLE_EMPTY" }], state: null };
    }

    // 1) verify hash chain integrity within this slice
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (i === 0) continue;
      const prev = entries[i - 1]!;
      if (e.prev_hash !== prev.hash) {
        errors.push({
          code: "CHAIN_BREAK",
          seq: e.seq,
          expected_prev_hash: prev.hash,
          actual_prev_hash: e.prev_hash,
        });
      }
    }

    // 2) verify signatures where present
    for (const e of entries) {
      if (!e.sig || !e.key_id || !e.tenant_id) continue; // unsigned ok in v1
      const verifier = opts.resolveVerifier({ tenant_id: String(e.tenant_id), key_id: String(e.key_id) });
      if (!verifier) {
        errors.push({ code: "NO_VERIFIER", seq: e.seq, tenant_id: e.tenant_id, key_id: e.key_id });
        continue;
      }
      const ok = verifier.verify(e.hash, String(e.sig));
      if (!ok) errors.push({ code: "BAD_SIGNATURE", seq: e.seq, tenant_id: e.tenant_id, key_id: e.key_id });
    }

    // 3) reconstruct latest federation state (last entry wins)
    const last = entries[entries.length - 1]!;
    const state = ledgerEntryToFederationEvent(last);

    return { ok: errors.length === 0, errors, state };
  }

  async getLatestFederationState(federation_id: string): Promise<FederationEvent | null> {
    const entries = await this.ledger.listLedgerEntries({ limit: 1_000_000 });
    const fedEntries = entries.filter((e) => e.decision_id === federation_id);
    if (fedEntries.length === 0) return null;
    return ledgerEntryToFederationEvent(fedEntries[fedEntries.length - 1]!);
  }
}

function ledgerEntryToFederationEvent(e: LedgerEntry): FederationEvent {
  const p = (e.payload ?? {}) as any;
  const base: FederationEvent = {
    federation_id: String(p.federation_id ?? e.decision_id ?? ""),
    at: String(p.at ?? e.at),
    purpose: String(p.purpose ?? "UNKNOWN"),
    payload: p.payload ?? null,
    payload_hash: String(p.payload_hash ?? ""),
    tenant_a: String(p.tenant_a ?? ""),
    tenant_b: String(p.tenant_b ?? ""),
    status: (p.status ?? "PROPOSED") as any,
    challenged: p.challenged ?? null,
  };

  // we reuse ledger signature fields as the "signature for that action"
  // For demo: treat PROPOSED entry sig as A sig; COSIGNED entry sig as B sig.
  if (e.type === ("FEDERATION_EVENT_PROPOSED" as any)) {
    base.a_sig = { sig_alg: e.sig_alg ?? null, key_id: e.key_id ?? null, sig: e.sig ?? null };
  }
  if (e.type === ("FEDERATION_EVENT_COSIGNED" as any)) {
    base.b_sig = { sig_alg: e.sig_alg ?? null, key_id: e.key_id ?? null, sig: e.sig ?? null };
  }

  return base;
}
