import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from "@/lib/auth/totp";

/**
 * The published vectors, so this is proved rather than believed. A subtly
 * wrong implementation locks every user out of their own account, and the
 * failure looks to them like a broken phone.
 */

// RFC 4648 §10.
describe("base32", () => {
  it("matches the RFC 4648 vectors", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of cases) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
  });

  it("ignores the spaces and padding a person types", () => {
    expect(base32Decode("MZXW 6YTB OI==").toString()).toBe("foobar");
  });
});

// RFC 4226 §D, the HOTP vectors for the ASCII secret "12345678901234567890".
describe("hotp", () => {
  it("matches the RFC 4226 vectors", () => {
    const secret = Buffer.from("12345678901234567890");
    const expected = [
      "755224", "287082", "359152", "969429", "338314",
      "254676", "287922", "162583", "399871", "520489",
    ];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });
});

// RFC 6238 §B, SHA-1 rows.
describe("totp", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  it("matches the RFC 6238 vectors", () => {
    for (const [seconds, code] of vectors) {
      expect(totp(secret, new Date(seconds * 1000))).toBe(code);
    }
  });

  it("accepts the code from one step either side, for clock drift", () => {
    const at = new Date(1111111109 * 1000);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 30_000)), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + 30_000)), at)).toBe(true);
  });

  it("refuses a code two steps away", () => {
    const at = new Date(1111111109 * 1000);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 90_000)), at)).toBe(false);
  });

  it("refuses anything that is not six digits", () => {
    const at = new Date(59_000);
    for (const junk of ["", "12345", "1234567", "abcdef", "  ", "28708"]) {
      expect(verifyTotp(secret, junk, at)).toBe(false);
    }
  });

  it("accepts a code the user typed with a space in it", () => {
    const at = new Date(59_000);
    expect(verifyTotp(secret, "287 082", at)).toBe(true);
  });

  it("refuses every code when the secret is unusable", () => {
    expect(verifyTotp("", "287082", new Date(59_000))).toBe(false);
  });
});

describe("otpauthUri", () => {
  it("carries everything an authenticator needs to agree with us", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "sam@acme.com", issuer: "Cappuccino" });
    expect(uri).toContain("otpauth://totp/Cappuccino%3Asam%40acme.com");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
