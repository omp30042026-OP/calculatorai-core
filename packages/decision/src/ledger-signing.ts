// packages/decision/src/ledger-signing.ts
import crypto from "node:crypto";

export type LedgerSigAlg = "HMAC_SHA256" | "ED25519";

export function isLedgerSigAlg(x: any): x is LedgerSigAlg {
  return x === "HMAC_SHA256" || x === "ED25519";
}

export type LedgerSigner = {
  alg: LedgerSigAlg;
  key_id: string;
  sign(hash: string): string; // base64
};

export type LedgerVerifier = {
  alg: LedgerSigAlg;
  key_id: string;
  verify(hash: string, sigBase64: string): boolean;
};

// --------------------
// small helpers
// --------------------
function assertNonEmptyString(v: any, name: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v;
}

function normalizeHash(hash: any): string {
  // Prevent Buffer.from(undefined) and similar runtime errors.
  return assertNonEmptyString(hash, "hash");
}

function normalizeSig(sigBase64: any): string {
  return assertNonEmptyString(sigBase64, "sigBase64");
}

function safeBase64ToBuf(b64: string): Buffer | null {
  try {
    const s = (b64 ?? "").trim();
    if (!s) return null;
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

// --------------------
// HMAC-SHA256 (unchanged API)
// --------------------
export function createHmacSigner(secret: string, key_id: string): LedgerSigner;
export function createHmacSigner(input: { secret: string; key_id: string }): LedgerSigner;
export function createHmacSigner(a: any, b?: any): LedgerSigner {
  const secretRaw = typeof a === "string" ? a : a?.secret;
  const keyIdRaw = typeof a === "string" ? b : a?.key_id;

  const secret = assertNonEmptyString(secretRaw, "secret");
  const key_id = assertNonEmptyString(keyIdRaw, "key_id");

  return {
    alg: "HMAC_SHA256",
    key_id,
    sign(hash: string) {
      const h = normalizeHash(hash);
      return crypto.createHmac("sha256", secret).update(h, "utf8").digest("base64");
    },
  };
}

export function createHmacVerifier(secret: string, key_id: string): LedgerVerifier;
export function createHmacVerifier(input: { secret: string; key_id: string }): LedgerVerifier;
export function createHmacVerifier(a: any, b?: any): LedgerVerifier {
  const secretRaw = typeof a === "string" ? a : a?.secret;
  const keyIdRaw = typeof a === "string" ? b : a?.key_id;

  const secret = assertNonEmptyString(secretRaw, "secret");
  const key_id = assertNonEmptyString(keyIdRaw, "key_id");

  return {
    alg: "HMAC_SHA256",
    key_id,
    verify(hash: string, sigBase64: string) {
      const h = normalizeHash(hash);
      const sig = normalizeSig(sigBase64);

      const expected = crypto.createHmac("sha256", secret).update(h, "utf8").digest("base64");

      const aBuf = safeBase64ToBuf(expected);
      const bBuf = safeBase64ToBuf(sig);
      if (!aBuf || !bBuf) return false;
      if (aBuf.length !== bBuf.length) return false;

      return crypto.timingSafeEqual(aBuf, bBuf);
    },
  };
}

// --------------------
// ED25519
// Backward compatible: keep existing (string, key_id) signature,
// but ALSO allow object form like HMAC (helps avoid breaking other files).
// --------------------
export function createEd25519Signer(private_key_pem: string, key_id: string): LedgerSigner;
export function createEd25519Signer(input: { private_key_pem: string; key_id: string }): LedgerSigner;
export function createEd25519Signer(a: any, b?: any): LedgerSigner {
  const pemRaw = typeof a === "string" ? a : a?.private_key_pem;
  const keyIdRaw = typeof a === "string" ? b : a?.key_id;

  const pem = assertNonEmptyString(pemRaw, "private_key_pem");
  const kid = assertNonEmptyString(keyIdRaw, "key_id");

  const key = crypto.createPrivateKey(pem);

  return {
    alg: "ED25519",
    key_id: kid,
    sign(hash: string) {
      const h = normalizeHash(hash);
      const sig = crypto.sign(null, Buffer.from(h, "utf8"), key);
      return sig.toString("base64");
    },
  };
}

export function createEd25519Verifier(public_key_pem: string, key_id: string): LedgerVerifier;
export function createEd25519Verifier(input: { public_key_pem: string; key_id: string }): LedgerVerifier;
export function createEd25519Verifier(a: any, b?: any): LedgerVerifier {
  const pemRaw = typeof a === "string" ? a : a?.public_key_pem;
  const keyIdRaw = typeof a === "string" ? b : a?.key_id;

  const pem = assertNonEmptyString(pemRaw, "public_key_pem");
  const kid = assertNonEmptyString(keyIdRaw, "key_id");

  const key = crypto.createPublicKey(pem);

  return {
    alg: "ED25519",
    key_id: kid,
    verify(hash: string, sigBase64: string) {
      const h = normalizeHash(hash);
      const sig = normalizeSig(sigBase64);

      const sigBuf = safeBase64ToBuf(sig);
      if (!sigBuf) return false;

      return crypto.verify(null, Buffer.from(h, "utf8"), key, sigBuf);
    },
  };
}

// --------------------
// Optional helpers (do not affect existing callers)
// --------------------
export function safeVerify(verifier: LedgerVerifier, hash: any, sigBase64: any): boolean {
  try {
    return verifier.verify(hash, sigBase64);
  } catch {
    return false;
  }
}

export function safeSign(signer: LedgerSigner, hash: any): string | null {
  try {
    return signer.sign(hash);
  } catch {
    return null;
  }
}


