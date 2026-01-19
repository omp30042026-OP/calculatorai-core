// packages/decision/src/ledger-keys.ts
export type LedgerSigAlg = "HMAC_SHA256" | "ED25519";

export type TenantLedgerKey =
  | {
      tenant_id: string;
      key_id: string;
      alg: "HMAC_SHA256";
      // base64 or raw string secret (MVP: string)
      secret: string;
      created_at?: string;
      revoked?: boolean;
    }
  | {
      tenant_id: string;
      key_id: string;
      alg: "ED25519";
      // PEM strings (MVP)
      public_key_pem: string;
      private_key_pem?: string;
      created_at?: string;
      revoked?: boolean;
    };

export type LedgerVerifyPolicy = {
  /**
   * If true: every entry MUST have a signature and it MUST verify.
   * If false: entries may be unsigned; but if signed, signature must verify.
   */
  require_signatures?: boolean;

  /**
   * If true: allow entries with sig fields missing.
   * (Ignored if require_signatures=true)
   */
  allow_unsigned?: boolean;
};

export interface TenantLedgerKeyStore {
  getKey(tenant_id: string, key_id: string): Promise<TenantLedgerKey | null>;
  getActiveSigningKey(
    tenant_id: string,
    alg?: LedgerSigAlg
  ): Promise<TenantLedgerKey | null>;
}

/**
 * MVP in-memory store. Later replace with DB-backed key registry + rotation UI.
 */
export class InMemoryTenantLedgerKeyStore implements TenantLedgerKeyStore {
  private keys: TenantLedgerKey[] = [];

  constructor(keys: TenantLedgerKey[] = []) {
    this.keys = [...keys];
  }

  addKey(k: TenantLedgerKey) {
    this.keys.push(k);
  }

  revokeKey(tenant_id: string, key_id: string) {
    for (const k of this.keys) {
      if (k.tenant_id === tenant_id && k.key_id === key_id) {
        (k as any).revoked = true;
      }
    }
  }

  async getKey(tenant_id: string, key_id: string): Promise<TenantLedgerKey | null> {
    const k = this.keys.find(
      (x) => x.tenant_id === tenant_id && x.key_id === key_id && !x.revoked
    );
    return k ?? null;
  }

  async getActiveSigningKey(
    tenant_id: string,
    alg?: LedgerSigAlg
  ): Promise<TenantLedgerKey | null> {
    // MVP: "most recent non-revoked" key (last wins)
    const candidates = this.keys
      .filter((k) => k.tenant_id === tenant_id && !k.revoked)
      .filter((k) => (alg ? k.alg === alg : true));

    return candidates.length ? candidates[candidates.length - 1]! : null;
  }
}

