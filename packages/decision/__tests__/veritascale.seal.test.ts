import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "veritascale-seal-"));
}

function writeJson(file: string, obj: unknown) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("veritascale seal", () => {
  it("is idempotent (sealing twice keeps signatures at 1)", () => {
    const cwd = process.cwd();
    const dir = tmpdir();

    // copy the existing json fixture if you have one; else create a minimal decision
    const decision = {
      decision_id: "d1",
      version: 1,
      state: "DRAFT",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      meta: {},
      artifacts: {},
      risk: { owner_id: null, severity: null, blast_radius: [], impacted_systems: [], rollback_plan_id: null, rollback_owner_id: null, notes: null, links: [] },
      signatures: [],
      history: [],
    };
    const f = path.join(dir, "decision.json");
    writeJson(f, decision);

    // generate ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    fs.writeFileSync(path.join(dir, "priv.pem"), privPem, "utf8");

    // 1st seal
    const r1 = run("veritascale", ["seal", "decision.json", "--key", "priv.pem", "--embed-pub"], dir);
    expect(r1.code).toBe(0);
    expect(readJson(f).signatures?.length ?? 0).toBe(1);

    // 2nd seal
    const r2 = run("veritascale", ["seal", "decision.json", "--key", "priv.pem", "--embed-pub"], dir);
    expect(r2.code).toBe(0);
    expect(readJson(f).signatures?.length ?? 0).toBe(1);

    // strict verify should succeed
    const r3 = run("veritascale", ["verify", "decision.json", "--strict", "--verify-sigs"], dir);
    expect(r3.code).toBe(0);

    // avoid unused warning
    expect(cwd.length).toBeGreaterThan(0);
  });

  it("tampering after seal breaks strict verify and signature check", () => {
    const dir = tmpdir();
    const decision = {
      decision_id: "d2",
      version: 1,
      state: "DRAFT",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      meta: {},
      artifacts: {},
      risk: { owner_id: null, severity: null, blast_radius: [], impacted_systems: [], rollback_plan_id: null, rollback_owner_id: null, notes: null, links: [] },
      signatures: [],
      history: [],
    };
    const f = path.join(dir, "decision.json");
    writeJson(f, decision);

    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(path.join(dir, "priv.pem"), privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "utf8");

    // seal
    expect(run("veritascale", ["seal", "decision.json", "--key", "priv.pem", "--embed-pub"], dir).code).toBe(0);

    // tamper
    const d = readJson(f);
    d.meta = d.meta || {};
    d.meta.note = "tampered";
    writeJson(f, d);

    // strict verify should FAIL
    const r = run("veritascale", ["verify", "decision.json", "--strict", "--verify-sigs"], dir);
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain("fail");
  });

  it("reseal after tamper restores strict verify", () => {
    const dir = tmpdir();
    const decision = {
      decision_id: "d3",
      version: 1,
      state: "DRAFT",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      meta: {},
      artifacts: {},
      risk: { owner_id: null, severity: null, blast_radius: [], impacted_systems: [], rollback_plan_id: null, rollback_owner_id: null, notes: null, links: [] },
      signatures: [],
      history: [],
    };
    const f = path.join(dir, "decision.json");
    writeJson(f, decision);

    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(path.join(dir, "priv.pem"), privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "utf8");

    // seal
    expect(run("veritascale", ["seal", "decision.json", "--key", "priv.pem", "--embed-pub"], dir).code).toBe(0);

    // tamper
    const d = readJson(f);
    d.meta.note = "tampered";
    writeJson(f, d);

    // reseal
    expect(run("veritascale", ["seal", "decision.json", "--key", "priv.pem", "--embed-pub"], dir).code).toBe(0);

    // strict verify OK again
    const r = run("veritascale", ["verify", "decision.json", "--strict", "--verify-sigs"], dir);
    expect(r.code).toBe(0);

    // signatures should still be 1 (idempotent / replace)
    expect(readJson(f).signatures?.length ?? 0).toBe(1);
  });

  it("verifies with --pubkey when signature has no embedded public_key_pem", () => {
  const dir = tmpdir();
  const f = path.join(dir, "decision.json");

  // write a tiny decision
  writeJson(f, { decision_id: "d1", meta: {} });

  // generate ed25519 keys (no external deps)
  const crypto = require("node:crypto");
  const fs = require("node:fs");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "priv.pem"), privateKey.export({ format: "pem", type: "pkcs8" }));
  fs.writeFileSync(path.join(dir, "pub.pem"), publicKey.export({ format: "pem", type: "spki" }));

  // seal WITHOUT embedding pubkey
  const r1 = run("veritascale", ["seal", "decision.json", "--key", "priv.pem"], dir);
  expect(r1.code).toBe(0);

  // verify should FAIL without pubkey override
  const rFail = run("veritascale", ["verify", "decision.json", "--strict", "--verify-sigs"], dir);
  expect(rFail.code).toBe(1);

  // verify should PASS with --pubkey override
  const rOk = run(
    "veritascale",
    ["verify", "decision.json", "--strict", "--verify-sigs", "--pubkey", "pub.pem"],
    dir
  );
  expect(rOk.code).toBe(0);

  // signatures should still be 1
  expect(readJson(f).signatures?.length ?? 0).toBe(1);
});


it("sign --replace keeps signatures at 1", () => {
  const dir = tmpdir();
  const f = path.join(dir, "decision.json");

  writeJson(f, { decision_id: "s1", meta: {}, signatures: [] });

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "priv.pem"), privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "utf8");

  expect(run("veritascale", ["sign", "decision.json", "--key", "priv.pem", "--replace", "--embed-pub"], dir).code).toBe(0);
  expect(readJson(f).signatures?.length ?? 0).toBe(1);

  expect(run("veritascale", ["sign", "decision.json", "--key", "priv.pem", "--replace", "--embed-pub"], dir).code).toBe(0);
  expect(readJson(f).signatures?.length ?? 0).toBe(1);
});



it("fails verify when --pubkey is wrong", () => {
  const dir = tmpdir();
  const f = path.join(dir, "decision.json");
  writeJson(f, { decision_id: "wrong-key-test", meta: {} });

  // keypair A (used to sign)
  const a = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "priv.pem"), a.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "utf8");

  // keypair B (wrong pubkey for verify override)
  const b = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(path.join(dir, "wrong_pub.pem"), b.publicKey.export({ format: "pem", type: "spki" }).toString(), "utf8");

  // seal WITHOUT embedding pubkey
  expect(run("veritascale", ["seal", "decision.json", "--key", "priv.pem"], dir).code).toBe(0);

  // verify should fail with wrong pubkey
  const rWrong = run("veritascale", ["verify", "decision.json", "--strict", "--verify-sigs", "--pubkey", "wrong_pub.pem"], dir);
  expect(rWrong.code).toBe(1);
});



});
