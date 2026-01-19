// packages/decision/src/ledger-store.ts
import type { LedgerEntry, LedgerQuery, LedgerVerifyReport, LedgerVerifierRegistry, LedgerEntryType } from "./ledger.js";
import type { LedgerSigner, LedgerVerifier } from "./ledger-signing.js";

// ✅ Feature 11-3: optional store-level write policy
export type LedgerWritePolicy = {
  require_signatures?: boolean;
  require_signatures_for_types?: LedgerEntryType[];
};

export type AppendLedgerEntryInput = Omit<
  LedgerEntry,
  "seq" | "prev_hash" | "hash" | "sig_alg" | "key_id" | "sig"
> & {
  signer?: LedgerSigner;
};

export type ExportLedgerRangeInput = {
  from_seq: number;
  to_seq: number;
};

export type VerifyLedgerOptions = {
  require_signatures?: boolean;

  // existing
  resolveVerifier?: (e: LedgerEntry) => LedgerVerifier | null;

  // ✅ Feature 11-4
  verifierRegistry?: LedgerVerifierRegistry;
};

export interface DecisionLedgerStore {
  runInTransaction?<T>(fn: () => Promise<T>): Promise<T>;

  appendLedgerEntry(input: AppendLedgerEntryInput): Promise<LedgerEntry>;
  listLedgerEntries(query?: LedgerQuery): Promise<LedgerEntry[]>;
  exportLedgerRange(input: ExportLedgerRangeInput): Promise<LedgerEntry[]>;
  verifyLedger(opts?: VerifyLedgerOptions): Promise<LedgerVerifyReport>;
}

