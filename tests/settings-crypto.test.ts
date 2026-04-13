import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __keyPathForTests,
  __resetCryptoCacheForTests,
  decryptSecret,
  encryptSecret,
} from "../lib/settings/crypto";

describe("settings crypto (AES-256-GCM with local key file)", () => {
  let tmpDir: string;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cca-crypto-"));
    mkdirSync(tmpDir, { recursive: true });
    originalOverride = process.env.CCA_ENCRYPTION_KEY_PATH;
    process.env.CCA_ENCRYPTION_KEY_PATH = join(tmpDir, ".encryption-key");
    __resetCryptoCacheForTests();
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.CCA_ENCRYPTION_KEY_PATH;
    } else {
      process.env.CCA_ENCRYPTION_KEY_PATH = originalOverride;
    }
    __resetCryptoCacheForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a secret end-to-end", () => {
    const secret = "sk-ant-api03-" + "a".repeat(64);
    const payload = encryptSecret(secret);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload.includes(secret)).toBe(false);
    expect(decryptSecret(payload)).toBe(secret);
  });

  it("writes the key file with 0600 permissions", () => {
    encryptSecret("anything");
    const path = __keyPathForTests();
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects tampered ciphertext (auth tag check)", () => {
    const payload = encryptSecret("another-secret-value-" + "b".repeat(40));
    const parts = payload.split(":");
    // Flip a byte inside the ciphertext segment
    const enc = Buffer.from(parts[3], "base64");
    enc[0] ^= 0x01;
    parts[3] = enc.toString("base64");
    const tampered = parts.join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects payloads missing the v1 prefix", () => {
    expect(() => decryptSecret("plain-text")).toThrow(/v1/);
  });
});
