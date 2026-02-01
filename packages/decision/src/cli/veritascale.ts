// packages/decision/src/cli/veritascale.ts
/* eslint-disable no-console */

import * as fs from "node:fs";
import * as path from "node:path";

import * as crypto from "node:crypto";

import { sealDecision } from "../seal.js";

/**
 * NOTE:
 * - This file is TypeScript and must be `noImplicitAny` clean.
 * - It runs under CommonJS in your repo, so avoid `import.meta`.
 * - We load optional deps (better-sqlite3) via require() at runtime.
 */

// ---- core modules (local) ----
import {
  computePublicStateHash,
  computeTamperStateHash,
  normalizeForStateHash,
  stripNonStateFieldsForHash,
} from "../state-hash.js";

import { stableStringify } from "../stable-json.js";



type VerifyResult = {
  ok: boolean;
  file: string;
  strict: boolean;
  computed: {
    public_state_hash: string;
    tamper_state_hash: string;
  };
  stored: {
    public_state_hash: string | null;
    tamper_state_hash: string | null;
  };
  match: {
    public_state_hash: boolean | null;
    tamper_state_hash: boolean | null;
  };
  note: string | null;

 signatures: {
    requested: boolean;
    pubkey: string | null;
    ok: boolean | null;
    details: Array<{ index: number; ok: boolean; reason: string | null; key_id: string | null }>;
    note: string | null;
  };


};

type DiaStatsResult = {
  ok: boolean;
  db: string;
  tables: string[];
  counts: Record<string, number>;
  decision_table: string | null;
  decision_table_info?: {
    columns: Array<{ name: string; type: string }>;
    id_column: string | null;
    json_column: string | null;
  };
};

type SqliteTableRow = { name: string };
type SqliteCountRow = { n: number };
type SqlitePragmaRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

type DbLike = {
  prepare: (sql: string) => {
    all: (...params: Array<unknown>) => Array<any>;
    get: (...params: Array<unknown>) => any;
  };
  close: () => void;
};

function usage(): string {
  return `veritascale - Veritascale Decision & Truth OS CLI

Usage:
  veritascale --help
  veritascale version

  veritascale hash <file.json>
  veritascale normalize <file.json>
  veritascale verify <file.json> [--json] [--strict] [--verify-sigs] [--pubkey <path>]
  veritascale sign <file.json> --key <path> [--out <file.json>] [--actor <id>] [--embed-pub] [--replace]
  veritascale seal <file.json> --key <path> [--out <file.json>] [--actor <id>] [--embed-pub]
  

  veritascale dia stats --db <path> [--json]
  veritascale dia export --db <path> --decision <id> [--out <file.json>]
  veritascale dia verify --db <path> --decision <id> [--json] [--strict]
  veritascale dia verify --db <path> --decision <id> [--json] [--strict] [--verify-sigs] [--pubkey <path>]
  veritascale seal <file.json> --key <path> [--out <file.json>] [--actor <id>] [--embed-pub]

Examples:
  veritascale hash decision.json
  veritascale normalize decision.json
  veritascale verify decision.json --json
  veritascale verify decision.json --json --strict

  veritascale dia stats --db ./dia.db
  veritascale dia export --db ./dia.db --decision d2 --out decision.json
  veritascale dia verify --db ./dia.db --decision d2 --json --strict
`;
}

// -------------------- file helpers --------------------

function readJsonFile(filePath: string): unknown {
  const abs = path.resolve(process.cwd(), filePath);
  let raw: string;
    try {
    raw = fs.readFileSync(abs, "utf8");
    } catch {
    console.error(`[veritascale] file not found: ${filePath}`);
    process.exit(1);
    }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`[veritascale] "${filePath}" is not valid JSON.`);
    console.error(`[veritascale] First 120 chars: ${raw.slice(0, 120)}`);
    process.exit(1);
  }
}

function writeJsonPretty(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function writeFilePretty(outFile: string, obj: unknown): void {
  const abs = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function inferStoredHashes(decision: unknown): { stored_public: string | null; stored_tamper: string | null } {
  const d = decision as any;

  const stored_public: string | null =
    d?.public_state_hash ??
    d?.state?.public_state_hash ??
    d?.state?.public_hash ??
    d?.hashes?.public ??
    null;

  const stored_tamper: string | null =
    d?.tamper_state_hash ??
    d?.state?.tamper_state_hash ??
    d?.state?.tamper_hash ??
    d?.hashes?.tamper ??
    null;

  return { stored_public, stored_tamper };
}


function keyFingerprintSha256(publicKeyPem: string): string {
  const pub = crypto.createPublicKey(publicKeyPem);
  const der = pub.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function buildSignaturePayload(
  decision: unknown
): { decision_id: string | null; public_state_hash: string; tamper_state_hash: string } {
  const d = decision as any;

  // Canonical-first: signatures must be over the same “state” that hashing uses.
  const canonical = stripNonStateFieldsForHash(decision as any);

  return {
    decision_id: d?.decision_id ?? d?.id ?? null,
    public_state_hash: computePublicStateHash(canonical),
    tamper_state_hash: computeTamperStateHash(canonical),
  };
}

    function signDecision(params: {
    decision: unknown;
    privateKeyPemPath: string;
    actorId: string | null;
    embedPub: boolean;
    }): {
    kind: "VERITASCALE_SIGNATURE_V1";
    alg: "ed25519";
    key_id: string;
    actor_id: string | null;
    created_at: string;
    payload: { decision_id: string | null; public_state_hash: string; tamper_state_hash: string };
    signature_b64: string;
    public_key_pem: string | null;
    } {
   const { decision, privateKeyPemPath, actorId, embedPub } = params;
  const privPem = fs.readFileSync(path.resolve(privateKeyPemPath), "utf8");
  const priv = crypto.createPrivateKey(privPem);
  const pubPem = crypto.createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();

  const key_id = keyFingerprintSha256(pubPem);
  const created_at = new Date().toISOString();
  const payload = buildSignaturePayload(decision);

  const signable = stableStringify({
    kind: "VERITASCALE_SIGNATURE_V1",
    alg: "ed25519",
    key_id,
    actor_id: actorId ?? null,
    created_at,
    payload,
  });

  const sig = crypto.sign(null, Buffer.from(signable, "utf8"), priv).toString("base64");

  return {
    kind: "VERITASCALE_SIGNATURE_V1",
    alg: "ed25519",
    key_id,
    actor_id: actorId ?? null,
    created_at,
    payload,
    signature_b64: sig,
    public_key_pem: embedPub ? pubPem : null,
  };
}

function verifyOneSignature(
  sig: any,
  pubKeyPemOverride: string | null
): { ok: boolean; reason?: string } {
  if (!sig || sig.kind !== "VERITASCALE_SIGNATURE_V1") return { ok: false, reason: "unsupported_signature_kind" };
  if (sig.alg !== "ed25519") return { ok: false, reason: "unsupported_alg" };

  const pubPem = pubKeyPemOverride || sig.public_key_pem;
  if (!pubPem) return { ok: false, reason: "missing_public_key" };

  let pub;
  try { pub = crypto.createPublicKey(pubPem); } catch { return { ok: false, reason: "invalid_public_key" }; }

  const expectedKeyId = keyFingerprintSha256(pubPem);
  if (sig.key_id !== expectedKeyId) return { ok: false, reason: "key_id_mismatch" };

  const signable = stableStringify({
    kind: "VERITASCALE_SIGNATURE_V1",
    alg: "ed25519",
    key_id: sig.key_id,
    actor_id: sig.actor_id ?? null,
    created_at: sig.created_at,
    payload: sig.payload,
  });

  const ok = crypto.verify(
    null,
    Buffer.from(signable, "utf8"),
    pub,
    Buffer.from(sig.signature_b64, "base64")
  );

  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}


// -------------------- core commands --------------------

function cmdHash(filePath: string): void {
  const decision = readJsonFile(filePath);
  const tamper = computeTamperStateHash(decision);
  const pub = computePublicStateHash(decision);

  process.stdout.write(`public_state_hash: ${pub}\n`);
  process.stdout.write(`tamper_state_hash: ${tamper}\n`);
}

function cmdNormalize(filePath: string): void {
  const decision = readJsonFile(filePath);
  const norm = normalizeForStateHash(decision);
  process.stdout.write(stableStringify(norm) + "\n");
}





function cmdSign(
  filePath: string,
  keyPath: string,
  outFile: string | null,
  actorId: string | null,
  embedPub: boolean,
  replace: boolean
) {
  const decision = readJsonFile(filePath);

  const sig = signDecision({
    decision,
    privateKeyPemPath: keyPath,
    actorId,
    embedPub,
  });

  const d = decision as any;

  // ✅ FIX: stop stacking if --replace is passed
  if (!Array.isArray(d.signatures) || replace) d.signatures = [];
  d.signatures.push(sig);

  const target = outFile ?? filePath;
  const abs = path.resolve(process.cwd(), target);
  fs.writeFileSync(abs, JSON.stringify(d, null, 2) + "\n", "utf8");

  process.stdout.write(`[veritascale] signed: ${target}\n`);
  process.stdout.write(`[veritascale] key_id: ${sig.key_id}\n`);
}

function cmdSeal(
  filePath: string,
  keyPath: string,
  outFile: string | null,
  actorId: string | null,
  embedPub: boolean
): void {
  const decision = readJsonFile(filePath) as any;

  const privateKeyPem = fs.readFileSync(path.resolve(process.cwd(), keyPath), "utf8");

  const sealed = sealDecision({
    decision,
    privateKeyPem,
    actorId: actorId ?? null,
    embedPub,
  });

  const target = outFile ?? filePath;
  const abs = path.resolve(process.cwd(), target);
  fs.writeFileSync(abs, JSON.stringify(sealed, null, 2) + "\n", "utf8");

  process.stdout.write(`[veritascale] sealed: ${target}\n`);
  process.stdout.write(`[veritascale] public_state_hash: ${sealed.public_state_hash}\n`);
  process.stdout.write(`[veritascale] tamper_state_hash: ${sealed.tamper_state_hash}\n`);
  process.stdout.write(`[veritascale] key_id: ${sealed.signatures?.[0]?.key_id ?? "(missing)"}\n`);
}


function computeVerify(
  decision: unknown,
  fileLabel: string,
  asJson: boolean,
  strict: boolean,
  verifySigs: boolean,
  pubkeyPath: string | null
): boolean {
  const computed_public = computePublicStateHash(decision);
  const computed_tamper = computeTamperStateHash(decision);

  const { stored_public, stored_tamper } = inferStoredHashes(decision);

  const public_match: boolean | null = stored_public ? stored_public === computed_public : null;
  const tamper_match: boolean | null = stored_tamper ? stored_tamper === computed_tamper : null;

  const missingStored = !stored_public && !stored_tamper;


  let sigs_ok: boolean | null = null;
    let sig_details: any[] | null = null;
    let sig_note: string | null = null;

    const d = decision as any;
    const pubOverride: string | null = pubkeyPath ? fs.readFileSync(path.resolve(pubkeyPath), "utf8") : null;

    if (verifySigs || strict) {
        const sigs = Array.isArray(d?.signatures) ? (d.signatures as any[]) : [];
    if (sigs.length === 0) {
        sigs_ok = false;
        sig_details = [];
        sig_note = "No signatures found.";
    } else {
        sig_details = sigs.map((s: any, idx: number) => {
            const r = verifyOneSignature(s, pubOverride);

            // Strong binding: signature payload must match this decision's computed hashes
            if (r.ok) {
            const p = s?.payload ?? null;
            const binds =
                p &&
                p.public_state_hash === computed_public &&
                p.tamper_state_hash === computed_tamper;

            if (!binds) {
                return {
                index: idx,
                ok: false,
                reason: "payload_hash_mismatch",
                key_id: s?.key_id ?? null,
                };
            }
            }

            return { index: idx, ok: r.ok, reason: r.reason ?? null, key_id: s?.key_id ?? null };
        });
        sigs_ok = sig_details.every((x) => x.ok === true);
        sig_note = sigs_ok ? null : "One or more signatures failed verification.";
    }
    }

  const hashes_ok =
    (!strict && missingStored)
        ? true
        : (public_match === null || public_match === true) &&
        (tamper_match === null || tamper_match === true) &&
        !missingStored;

    const ok = hashes_ok && (sigs_ok === null ? true : sigs_ok === true);

   const note: string | null =
    missingStored
      ? (strict
          ? "Strict mode: missing stored hashes (public_state_hash/tamper_state_hash)."
          : "No stored hashes found in decision; verify computed-only.")
      : (strict && sigs_ok === false
          ? "Strict mode: signature verification failed (or signatures missing)."
          : null);

  if (asJson) {
    const out: VerifyResult = {
      ok,
      file: fileLabel,
      strict,
      computed: { public_state_hash: computed_public, tamper_state_hash: computed_tamper },
      stored: { public_state_hash: stored_public, tamper_state_hash: stored_tamper },
      match: { public_state_hash: public_match, tamper_state_hash: tamper_match },
      signatures: {
        requested: verifySigs || strict,
        pubkey: pubkeyPath,
        ok: sigs_ok,
        details: sig_details ?? [],
        note: sig_note,
      },
      note,
    };
    writeJsonPretty(out);
  } else {
    process.stdout.write(`file: ${fileLabel}\n`);
    process.stdout.write(`computed public_state_hash: ${computed_public}\n`);
    process.stdout.write(`computed tamper_state_hash: ${computed_tamper}\n`);

    if (stored_public || stored_tamper) {
      process.stdout.write(`stored public_state_hash: ${stored_public ?? "(missing)"}\n`);
      process.stdout.write(`stored tamper_state_hash: ${stored_tamper ?? "(missing)"}\n`);
      process.stdout.write(`match public_state_hash: ${public_match === null ? "(n/a)" : String(public_match)}\n`);
      process.stdout.write(`match tamper_state_hash: ${tamper_match === null ? "(n/a)" : String(tamper_match)}\n`);
    } else {
      process.stdout.write(
        strict
          ? "note: strict mode requires stored hashes (public_state_hash/tamper_state_hash)\n"
          : "note: no stored hashes found; verify computed-only\n"
      );
    }

    process.stdout.write(ok ? "OK\n" : "FAIL\n");

        if (verifySigs || strict) {
      process.stdout.write(`signatures requested: true\n`);
      process.stdout.write(`signatures ok: ${sigs_ok === null ? "(n/a)" : String(sigs_ok)}\n`);
      if (sig_note) process.stdout.write(`signatures note: ${sig_note}\n`);
      if (sig_details && sig_details.length > 0) {
        for (const d of sig_details) {
          process.stdout.write(
            `  sig[${d.index}] ok=${String(d.ok)} key_id=${d.key_id ?? "(none)"} reason=${d.reason ?? "(none)"}\n`
          );
        }
      }
    }

  }

  return ok;
}

function cmdVerify(filePath: string, asJson: boolean, strict: boolean, verifySigs: boolean, pubkeyPath: string | null) {
  const decision = readJsonFile(filePath);
  const ok = computeVerify(decision, filePath, asJson, strict, verifySigs, pubkeyPath);
  if (!ok) process.exit(1);
}

// -------------------- DIA / SQLite helpers --------------------

function requireBetterSqlite3(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("better-sqlite3");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[veritascale] DIA requires better-sqlite3 dependency.");
    console.error("[veritascale] Failed to load better-sqlite3:", msg);
    process.exit(1);
  }
}

function openDb(dbPath: string): DbLike {
  const BetterSqlite3 = requireBetterSqlite3();
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    return db as DbLike;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[veritascale] Failed to open DB: ${dbPath}`);
    console.error(`[veritascale] ${msg}`);
    process.exit(1);
  }
}

function listTables(db: DbLike): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as SqliteTableRow[];
  return rows.map((r) => r.name);
}

function countTable(db: DbLike, table: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(1) AS n FROM "${table}"`).get() as SqliteCountRow;
    return typeof row?.n === "number" ? row.n : null;
  } catch {
    return null;
  }
}

function getTableInfo(db: DbLike, table: string): SqlitePragmaRow[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as SqlitePragmaRow[];
  return rows;
}

function bestDecisionTable(tables: string[]): string | null {
  const preferred = ["decisions", "decision", "decision_store", "dia_decisions"];
  for (const p of preferred) {
    const hit = tables.find((t) => t.toLowerCase() === p);
    if (hit) return hit;
  }
  const any = tables.find((t) => t.toLowerCase().includes("decision"));
  return any ?? null;
}

function findJsonColumn(cols: SqlitePragmaRow[]): string | null {
  const names = cols.map((c) => String(c.name));
  const preferred = ["decision_json", "decision", "json", "payload", "data", "state"];
  for (const p of preferred) {
    const hit = names.find((n) => n.toLowerCase() === p);
    if (hit) return hit;
  }
  // fallback: first TEXT-ish column
  const firstText = cols.find((c) => String(c.type || "").toLowerCase().includes("text"));
  return firstText ? String(firstText.name) : null;
}

function findIdColumn(cols: SqlitePragmaRow[]): string | null {
  const names = cols.map((c) => String(c.name));
  const preferred = ["decision_id", "id"];
  for (const p of preferred) {
    const hit = names.find((n) => n.toLowerCase() === p);
    if (hit) return hit;
  }
  return names.length > 0 ? (names[0] ?? null) : null;
}

// -------------------- DIA commands --------------------

function cmdDiaStats(dbPath: string, asJson: boolean): void {
  const db = openDb(dbPath);
  try {
    const tables = listTables(db);
    const counts: Record<string, number> = {};

    for (const t of tables) {
      const n = countTable(db, t);
      if (n !== null) counts[t] = n;
    }

    const decisionTable = bestDecisionTable(tables);

    const out: DiaStatsResult = {
      ok: true,
      db: dbPath,
      tables,
      counts,
      decision_table: decisionTable,
    };

    if (decisionTable) {
      const cols = getTableInfo(db, decisionTable);
      out.decision_table_info = {
        columns: cols.map((c) => ({ name: String(c.name), type: String(c.type ?? "") })),
        id_column: findIdColumn(cols),
        json_column: findJsonColumn(cols),
      };
    }

    if (asJson) {
      writeJsonPretty(out);
    } else {
      process.stdout.write(`db: ${dbPath}\n`);
      process.stdout.write(`tables: ${tables.length}\n`);
      if (decisionTable) {
        process.stdout.write(`decision_table: ${decisionTable}\n`);
        const info = out.decision_table_info!;
        process.stdout.write(`id_column: ${info.id_column ?? "(none)"}\n`);
        process.stdout.write(`json_column: ${info.json_column ?? "(none)"}\n`);
      } else {
        process.stdout.write("decision_table: (not found)\n");
      }
    }
  } finally {
    db.close();
  }
}

function loadDecisionFromDia(db: DbLike, decisionTable: string, decisionId: string): unknown {
  const cols = getTableInfo(db, decisionTable);
  const idCol = findIdColumn(cols);
  const jsonCol = findJsonColumn(cols);

  if (!idCol || !jsonCol) {
    console.error(`[veritascale] Could not infer id/json column for table "${decisionTable}".`);
    console.error(`[veritascale] Columns: ${cols.map((c) => `${c.name}:${c.type}`).join(", ")}`);
    process.exit(1);
  }

  const row = db
    .prepare(`SELECT "${jsonCol}" AS j FROM "${decisionTable}" WHERE "${idCol}" = ? LIMIT 1`)
    .get(decisionId) as { j?: unknown } | undefined;

  if (!row) {
    console.error(`[veritascale] Decision not found: ${decisionId}`);
    process.exit(1);
  }

  const j = row.j;

  // if it's already object, return
  if (j && typeof j === "object") return j;

  // if it's a string, parse json
  if (typeof j === "string") {
    try {
      return JSON.parse(j);
    } catch {
      console.error(`[veritascale] Stored JSON column "${jsonCol}" is not valid JSON for decision ${decisionId}.`);
      console.error(`[veritascale] First 120 chars: ${j.slice(0, 120)}`);
      process.exit(1);
    }
  }

  console.error(`[veritascale] Unsupported JSON column type for "${jsonCol}": ${typeof j}`);
  process.exit(1);
}

function cmdDiaExport(dbPath: string, decisionId: string, outFile: string | null): void {
  const db = openDb(dbPath);
  try {
    const tables = listTables(db);
    const decisionTable = bestDecisionTable(tables);

    if (!decisionTable) {
      console.error("[veritascale] Could not find a decision table (tables containing 'decision').");
      console.error(`[veritascale] Tables: ${tables.join(", ")}`);
      process.exit(1);
    }

    const decision = loadDecisionFromDia(db, decisionTable, decisionId);

    if (outFile) {
      writeFilePretty(outFile, decision);
    } else {
      writeJsonPretty(decision);
    }
  } finally {
    db.close();
  }
}

function cmdDiaVerify(dbPath: string, decisionId: string, asJson: boolean, strict: boolean, verifySigs: boolean, pubkeyPath: string | null): void {
  const db = openDb(dbPath);
  try {
    const tables = listTables(db);
    const decisionTable = bestDecisionTable(tables);

    if (!decisionTable) {
      console.error("[veritascale] Could not find a decision table (tables containing 'decision').");
      console.error(`[veritascale] Tables: ${tables.join(", ")}`);
      process.exit(1);
    }

    const decision = loadDecisionFromDia(db, decisionTable, decisionId);
    const label = `dia:${dbPath}:${decisionId}`;
    const ok = computeVerify(decision, label, asJson, strict, verifySigs, pubkeyPath);
    if (!ok) process.exit(1);
  } finally {
    db.close();
  }
}

// -------------------- argv parsing --------------------

function getFlagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

function notImplemented(cmd: string): never {
  console.error(`[veritascale] "${cmd}" is planned but not implemented yet.`);
  console.error(usage());
  process.exit(1);
}

export function run(argv: string[] = process.argv): void {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const cmd = args[0];

  if (cmd === "version") {
    process.stdout.write("veritascale cli v1\n");
    process.exit(0);
  }

  if (cmd === "hash") {
    const file = args[1];
    if (!file || file.startsWith("--")) {
      console.error("Missing file.\n");
      console.error(usage());
      process.exit(1);
    }
    cmdHash(file);
    process.exit(0);
  }

  if (cmd === "normalize") {
    const file = args[1];
    if (!file || file.startsWith("--")) {
      console.error("Missing file.\n");
      console.error(usage());
      process.exit(1);
    }
    cmdNormalize(file);
    process.exit(0);
  }

  if (cmd === "verify") {
    const file = args[1];
    const asJson = args.includes("--json");
    const strict = args.includes("--strict");
    const verifySigs = args.includes("--verify-sigs");
    const pubkeyPath = getFlagValue(args, "--pubkey");
    if (!file || file.startsWith("--")) {
      console.error("Missing file.\n");
      console.error(usage());
      process.exit(1);
    }
    cmdVerify(file, asJson, strict, verifySigs, pubkeyPath);
    process.exit(0);
  }

  if (cmd === "dia") {
    const sub = args[1];

    if (!sub || sub.startsWith("--")) {
      console.error("Missing dia subcommand.\n");
      console.error(usage());
      process.exit(1);
    }

    const dbPath = getFlagValue(args, "--db");
    const asJson = args.includes("--json");
    const strict = args.includes("--strict");
    const decisionId = getFlagValue(args, "--decision");
    const outFile = getFlagValue(args, "--out");

    if (!dbPath) {
      console.error("Missing --db <path>\n");
      console.error(usage());
      process.exit(1);
    }

    if (sub === "stats") {
      cmdDiaStats(dbPath, asJson);
      process.exit(0);
    }

    if (sub === "export") {
      if (!decisionId) {
        console.error("Missing --decision <id>\n");
        console.error(usage());
        process.exit(1);
      }
      cmdDiaExport(dbPath, decisionId, outFile);
      process.exit(0);
    }


    const verifySigs = args.includes("--verify-sigs");
    const pubkeyPath = getFlagValue(args, "--pubkey");
    if (sub === "verify") {
      if (!decisionId) {
        console.error("Missing --decision <id>\n");
        console.error(usage());
        process.exit(1);
      }
      cmdDiaVerify(dbPath, decisionId, asJson, strict, verifySigs, pubkeyPath);
      process.exit(0);
    }

    console.error(`Unknown dia command: ${sub}\n`);
    console.error(usage());
    process.exit(1);
  }

  if (cmd === "seal") {
        const file = args[1];
        const keyPath = getFlagValue(args, "--key");
        const outFile = getFlagValue(args, "--out");
        const actorId = getFlagValue(args, "--actor");
        const embedPub = args.includes("--embed-pub");

        if (!file || file.startsWith("--")) {
            console.error("Missing file.\n");
            console.error(usage());
            process.exit(1);
        }
        if (!keyPath) {
            console.error("Missing --key <path>\n");
            console.error(usage());
            process.exit(1);
        }

        cmdSeal(file, keyPath, outFile, actorId, embedPub);
        process.exit(0);
    }

  // planned stubs (future)
  if (cmd === "sign") {
    const file = args[1];
    const keyPath = getFlagValue(args, "--key");
    const outFile = getFlagValue(args, "--out");
    const actorId = getFlagValue(args, "--actor");
    const embedPub = args.includes("--embed-pub");

    if (!file || file.startsWith("--")) {
        console.error("Missing file.\n");
        console.error(usage());
        process.exit(1);
    }
    if (!keyPath) {
        console.error("Missing --key <path>\n");
        console.error(usage());
        process.exit(1);
    }


    const replace = true; // default to replace; no accidental stacking
    cmdSign(file, keyPath, outFile, actorId, embedPub, replace);
    process.exit(0);

    

    }


   


  console.error(`Unknown command: ${cmd}\n`);
  console.error(usage());
  process.exit(1);

   


}

// Entrypoint: works under both CommonJS (node) and tsx (ESM)
const g: any = globalThis as any;

// CJS path (node require)
if (typeof g.require === "function") {
  const req = g.require as NodeRequire;
  if (req.main === module) {
    run(process.argv);
  }
} else {
  // ESM / tsx path: execute when this file is the invoked script
  const argv1 = process.argv[1] ?? "";
  if (argv1.includes("veritascale.ts") || argv1.includes("veritascale.js")) {
    run(process.argv);
  }
}

