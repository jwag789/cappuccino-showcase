import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238), implemented rather than depended on.
 *
 * The algorithm is thirty lines and completely specified, and the RFC ships
 * test vectors — so this can be *proved* correct against the published values
 * instead of trusted because a package has a lot of downloads. That matters
 * more here than usual: a subtly wrong implementation locks every user out of
 * their own account, and the failure looks like "my phone is broken".
 *
 * SHA-1 and six digits, because that is what every authenticator app assumes
 * when it scans a setup key. The weakness of SHA-1 as a hash is irrelevant to
 * HMAC used this way, and choosing something stronger would produce codes that
 * Google Authenticator silently gets wrong.
 */

const DIGITS = 6;
const PERIOD = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A new shared secret, in the base32 form authenticator apps expect. */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one counter step. Exported so the RFC vectors can be run. */
export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);

  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totp(secret: string, at: Date = new Date()): string {
  return hotp(base32Decode(secret), Math.floor(at.getTime() / 1000 / PERIOD));
}

/**
 * Whether a submitted code is valid, allowing one step either side.
 *
 * The window exists because phone clocks drift and because a code typed at
 * 29.8 seconds arrives in the next step. One step each way is the usual
 * trade: wider makes a shoulder-surfed code useful for longer.
 *
 * Compared with a timing-safe comparison — the difference is unexploitable in
 * practice at six digits, but a constant-time compare costs nothing and means
 * nobody has to reason about whether it is.
 */
export function verifyTotp(secret: string, code: string, at: Date = new Date()): boolean {
  const submitted = code.replace(/\D/g, "");
  if (submitted.length !== DIGITS) return false;

  const key = base32Decode(secret);
  if (key.length === 0) return false;

  const step = Math.floor(at.getTime() / 1000 / PERIOD);
  for (const drift of [0, -1, 1]) {
    const expected = Buffer.from(hotp(key, step + drift));
    const given = Buffer.from(submitted);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

/** The URI an authenticator app reads, whether scanned or pasted. */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Grouped into fours, because people type this off a screen by hand. */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
