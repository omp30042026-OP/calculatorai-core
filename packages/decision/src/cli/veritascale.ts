#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// These are JS exports compiled/available at runtime inside your repo package.
// If you move paths later, keep these requires in sync.
let stateHash;
let stableJson;

const tryRequire = (p: string): any => {
  try { return require(p); } catch { return null; }
};

stateHash =
  tryRequire("../state-hash.js") ||
  tryRequire("../src/state-hash.js") ||
  tryRequire("../../decision/src/state-hash.js") ||
  null;

stableJson =
  tryRequire("../stable-json.js") ||
  tryRequire("../src/stable-json.js") ||
  tryRequire("../../decision/src/stable-json.js") ||
  null;

if (!stateHash || !stableJson) {
  console.error("[veritascale] failed to load core modules: cannot resolve state-hash/stable-json at runtime");
  process.exit(1);
}

const {
  computePublicStateHash,
  computeTamperStateHash,
  normalizeForStateHash,
} = stateHash;

const { stableStringify } = stableJson;

function usage() {
  return `veritascale - Veritascale Decision & Truth OS CLI

Usage:
  veritascale --help
  veritascale version
  veritascale hash <file.json>
  veritascale normalize <file.json>
  veritascale verify <file.json> [--json]

Planned (not implemented yet):
  veritascale sign <file.json> --key <path>
  veritascale dia stats --db <path>
  veritascale dia verify --db <path> --decision <id>
  veritascale dia export --db <path> --decision <id> > decision.json

Examples:
  veritascale hash decision.json
  veritascale normalize decision.json
  veritascale verify decision.json
  veritascale verify decision.json --json
`;
}

function readJsonFile(filePath: string) {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, "utf8");
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[veritascale] "${filePath}" is not valid JSON.`);
        console.error(`[veritascale] First 120 chars: ${raw.slice(0, 120)}`);
        process.exit(1);
    }
}

function writeJsonPretty(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function inferStoredHashes(decision: any) {
  const stored_public =
    decision?.public_state_hash ??
    decision?.state?.public_state_hash ??
    decision?.state?.public_hash ??
    decision?.hashes?.public ??
    null;

  const stored_tamper =
    decision?.tamper_state_hash ??
    decision?.state?.tamper_state_hash ??
    decision?.state?.tamper_hash ??
    decision?.hashes?.tamper ??
    null;

  return { stored_public, stored_tamper };
}

function cmdHash(filePath: string) {
  const decision = readJsonFile(filePath);
  const tamper = computeTamperStateHash(decision);
  const pub = computePublicStateHash(decision);

  process.stdout.write(`public_state_hash: ${pub}\n`);
  process.stdout.write(`tamper_state_hash: ${tamper}\n`);
}

function cmdNormalize(filePath: string) {
  const decision = readJsonFile(filePath);
  const norm = normalizeForStateHash(decision);
  process.stdout.write(stableStringify(norm) + "\n");
}

function cmdVerify(filePath: string, asJson: boolean) {
  const decision = readJsonFile(filePath);

  const computed_public = computePublicStateHash(decision);
  const computed_tamper = computeTamperStateHash(decision);

  const { stored_public, stored_tamper } = inferStoredHashes(decision);

  const public_match = stored_public ? stored_public === computed_public : null;
  const tamper_match = stored_tamper ? stored_tamper === computed_tamper : null;

  const ok =
    (public_match === null || public_match === true) &&
    (tamper_match === null || tamper_match === true);

  if (asJson) {
    writeJsonPretty({
      ok,
      file: filePath,
      computed: {
        public_state_hash: computed_public,
        tamper_state_hash: computed_tamper,
      },
      stored: {
        public_state_hash: stored_public,
        tamper_state_hash: stored_tamper,
      },
      match: {
        public_state_hash: public_match,
        tamper_state_hash: tamper_match,
      },
      note:
        stored_public || stored_tamper
          ? null
          : "No stored hashes found in decision; verify computed-only.",
    });
  } else {
    process.stdout.write(`file: ${filePath}\n`);
    process.stdout.write(`computed public_state_hash: ${computed_public}\n`);
    process.stdout.write(`computed tamper_state_hash: ${computed_tamper}\n`);

    if (stored_public || stored_tamper) {
      process.stdout.write(
        `stored public_state_hash: ${stored_public ?? "(missing)"}\n`
      );
      process.stdout.write(
        `stored tamper_state_hash: ${stored_tamper ?? "(missing)"}\n`
      );
      process.stdout.write(
        `match public_state_hash: ${
          public_match === null ? "(n/a)" : String(public_match)
        }\n`
      );
      process.stdout.write(
        `match tamper_state_hash: ${
          tamper_match === null ? "(n/a)" : String(tamper_match)
        }\n`
      );
    } else {
      process.stdout.write(`note: no stored hashes found; verify computed-only\n`);
    }

    process.stdout.write(ok ? "OK\n" : "FAIL\n");
  }

  if (!ok) process.exit(1);
}

function notImplemented(cmd: string) {
  console.error(`[veritascale] "${cmd}" is planned but not implemented yet.`);
  console.error(usage());
  process.exit(1);
}

function main(argv: string[]) {
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
    if (!file) {
      console.error("Missing file.\n");
      console.error(usage());
      process.exit(1);
    }
    cmdHash(file);
    process.exit(0);
  }

  if (cmd === "normalize") {
    const file = args[1];
    if (!file) {
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
    if (!file || file.startsWith("--")) {
      console.error("Missing file.\n");
      console.error(usage());
      process.exit(1);
    }
    cmdVerify(file, asJson);
    process.exit(0);
  }

  // stubs (so you don’t see "Unknown command" anymore)
  if (cmd === "sign") return notImplemented("sign");
  if (cmd === "dia") return notImplemented("dia");

  console.error(`Unknown command: ${cmd}\n`);
  console.error(usage());
  process.exit(1);
}

main(process.argv);

