import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function keyPath(): string {
  const override = process.env.CCA_ENCRYPTION_KEY_PATH;
  if (override && override.length > 0) return resolve(override);
  return resolve(process.cwd(), "data/.encryption-key");
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const ALG = "aes-256-gcm" as const;

let _cachedKey: Buffer | null = null;

function loadOrCreateKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const path = keyPath();
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length !== KEY_LEN) {
      throw new Error(
        `encryption key at ${path} is ${raw.length} bytes; expected ${KEY_LEN}`,
      );
    }
    _cachedKey = raw;
    return raw;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_LEN);
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is a no-op on filesystems that don't support it; mode on write covered the happy path
  }
  _cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("encrypted payload is not in v1 format");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_LEN) throw new Error(`bad iv length: ${iv.length}`);
  if (tag.length !== TAG_LEN) throw new Error(`bad tag length: ${tag.length}`);
  const key = loadOrCreateKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export function __resetCryptoCacheForTests(): void {
  _cachedKey = null;
}

export function __keyPathForTests(): string {
  return keyPath();
}
