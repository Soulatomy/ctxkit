import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "../config.js";

/**
 * AES-256-GCM encryption for secrets at rest (e.g. proxy passwords).
 *
 * Key resolution: FB_SECRET env var (hashed to 32 bytes) if present, else a
 * random 32-byte key file under the data dir (chmod 600). Encrypted values are
 * self-describing ("enc:iv:tag:data") so plaintext can be transparently migrated.
 */
const KEY_FILE = path.join(DATA_DIR, "secret.key");
const PREFIX = "enc:";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.FB_SECRET;
  if (env && env.trim()) {
    cachedKey = crypto.createHash("sha256").update(env).digest();
    return cachedKey;
  }
  ensureDataDirs();
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
  cachedKey = fs.readFileSync(KEY_FILE);
  return cachedKey;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted secret");
  const [iv, tag, data] = parts as [string, string, string];
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** Test hook: forget the cached key (e.g. after changing FB_SECRET). */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}
