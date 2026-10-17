import { beforeAll, describe, expect, it, vi } from "vitest";

// Set before importing: the key is read on first use, and these tests exercise
// that path.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const load = () => import("@/lib/crypto");

describe("secret encryption", () => {
  it("round-trips a value", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const secret = "xoxb-a-slack-token";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each time", async () => {
    const { encryptSecret } = await load();
    // A fresh IV per write. Deterministic output would leak which connections
    // share a token.
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("never contains the plaintext", async () => {
    const { encryptSecret } = await load();
    expect(encryptSecret("SUPER-SECRET")).not.toContain("SUPER-SECRET");
  });

  it("rejects tampered ciphertext instead of returning garbage", async () => {
    const { encryptSecret, decryptSecret } = await load();
    const [version, iv, tag, data] = encryptSecret("value").split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    // This is the point of GCM over CBC: authentication failure, not silent
    // corruption.
    expect(() => decryptSecret([version, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("passes through values written before encryption existed", async () => {
    const { decryptSecret, isEncrypted } = await load();
    // Rows predating the migration hold plaintext and must keep working until
    // db:encrypt-tokens has rewritten them.
    expect(decryptSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
    expect(isEncrypted("legacy-plaintext-token")).toBe(false);
    expect(isEncrypted("v1:a:b:c")).toBe(true);
  });

  it("handles null-ish values", async () => {
    const { decryptOptional, encryptOptional } = await load();
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional("")).toBeNull();
    expect(decryptOptional(null)).toBeNull();
  });

  // The key is cached after first use, so these need a fresh module instance
  // to exercise the resolution path at all.
  it("refuses a key that is not 32 bytes", async () => {
    vi.resetModules();
    const original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.alloc(8).toString("base64");
    const { encryptSecret } = await import("@/lib/crypto");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env.ENCRYPTION_KEY = original;
  });

  it("refuses to encrypt when no key is configured", async () => {
    vi.resetModules();
    const original = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    const { encryptSecret } = await import("@/lib/crypto");
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = original;
  });

  it("accepts a hex key as well as base64", async () => {
    vi.resetModules();
    const original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("hex");
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(encryptSecret("hex-keyed"))).toBe("hex-keyed");
    process.env.ENCRYPTION_KEY = original;
  });
});
