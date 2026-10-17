import { describe, expect, it } from "vitest";
import { challengeFor, createPkcePair, isValidVerifier } from "@/lib/pkce";

/**
 * Pinned against RFC 7636's own Appendix B vector rather than against whatever
 * this implementation happened to produce first.
 *
 * A wrong S256 transformation fails the same way a revoked credential does —
 * an opaque refusal at the token endpoint, after the user has already
 * authorized — so recording our own output as the expectation would make the
 * test agree with the bug.
 */

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("challengeFor", () => {
  it("matches the S256 example in RFC 7636 Appendix B", () => {
    expect(challengeFor(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("is base64url, so it needs no further encoding in a query string", () => {
    // `+` and `/` would be mangled by a URL encoder and `=` padding is
    // forbidden by the spec; base64url avoids all three.
    expect(challengeFor(RFC_VERIFIER)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("changes completely when the verifier changes by one character", () => {
    const near = RFC_VERIFIER.slice(0, -1) + "j";
    expect(challengeFor(near)).not.toBe(RFC_CHALLENGE);
  });
});

describe("isValidVerifier", () => {
  it("accepts the RFC's own verifier", () => {
    expect(isValidVerifier(RFC_VERIFIER)).toBe(true);
  });

  it("holds the 43-128 range Airtable enforces rather than merely documents", () => {
    expect(isValidVerifier("a".repeat(42))).toBe(false);
    expect(isValidVerifier("a".repeat(43))).toBe(true);
    expect(isValidVerifier("a".repeat(128))).toBe(true);
    expect(isValidVerifier("a".repeat(129))).toBe(false);
  });

  it("refuses anything outside the unreserved set", () => {
    // A verifier that reached us from a cookie could be anything; these are the
    // characters that would change meaning in a form body or a URL.
    for (const bad of ["+", "/", "=", " ", "%41", "a&b"]) {
      expect(isValidVerifier("a".repeat(42) + bad), bad).toBe(false);
    }
  });
});

describe("createPkcePair", () => {
  it("produces a verifier the spec and Airtable both accept", () => {
    for (let i = 0; i < 50; i++) {
      const { verifier } = createPkcePair();
      expect(isValidVerifier(verifier), verifier).toBe(true);
      // 32 bytes base64url-encode to exactly 43 characters, the floor.
      expect(verifier).toHaveLength(43);
    }
  });

  it("derives the challenge from the verifier it returns", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(challengeFor(verifier));
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(200);
  });
});
