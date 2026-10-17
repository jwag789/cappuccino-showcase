import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Deliberately not marked "server-only": scripts/encrypt-tokens.ts imports this
// and runs under tsx, outside Next's bundler, where that marker fails to
// resolve. It is server-side by construction anyway — node:crypto has no
// browser build — and nothing that reaches a client component imports it.

/**
 * Authenticated encryption for secrets held at rest — currently the OAuth
 * access and refresh tokens in workspace_connections.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than yielding
 * garbage. Stored as `v1:<iv>:<tag>:<ciphertext>`, all base64. The version
 * prefix is what lets the scheme change later without a flag day, and what
 * lets us recognise rows written before encryption existed.
 */

const PREFIX = "v1";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * Resolved on first use, never at module scope, so `next build` works without
 * credentials.
 *
 * Accepts base64 or hex. Generate one with:
 *   openssl rand -base64 32
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY environment variable is not set. Generate one with `openssl rand -base64 32`."
    );
  }

  const key = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. Generate one with \`openssl rand -base64 32\`.`
    );
  }

  cachedKey = key;
  return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ":"
  );
}

/**
 * Decrypts a stored secret.
 *
 * A value without the version prefix is returned unchanged: rows written
 * before encryption was introduced hold plaintext, and they must keep working
 * until `npm run db:encrypt-tokens` has rewritten them. Once that has run,
 * nothing in the table is unprefixed.
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;

  const [, ivB64, tagB64, dataB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted value");
  }

  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  return value ? encryptSecret(value) : null;
}

export function decryptOptional(value: string | null | undefined): string | null {
  return value ? decryptSecret(value) : null;
}
