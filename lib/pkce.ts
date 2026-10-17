/**
 * PKCE (RFC 7636), for the OAuth flows that require it.
 *
 * Airtable is the first source here to mandate it, and PKCE differs from the
 * `state` parameter in a way that decides how it has to be stored. `state` is
 * only ever compared to itself: leaking it lets somebody predict a value that
 * is useless without the user's session. The **verifier is a secret**. It is
 * what proves to the token endpoint that the client redeeming the code is the
 * client that requested it, so an attacker who can read it can redeem an
 * intercepted code — which is the entire attack PKCE exists to prevent.
 *
 * So the verifier goes in an httpOnly cookie and nowhere else. Never in the
 * URL, never in a readable cookie, never in `localStorage`: any of those turns
 * the handshake back into a plain authorization-code flow while continuing to
 * look like PKCE to everyone reading the code.
 */

import { createHash, randomBytes } from "crypto";

/**
 * A verifier and the challenge derived from it.
 *
 * Only the challenge is sent when the user is redirected out. The verifier is
 * held until they come back and is then sent once, to the token endpoint.
 */
export type PkcePair = { verifier: string; challenge: string };

/**
 * RFC 7636 allows 43-128 characters; 32 random bytes base64url-encode to
 * exactly 43, the floor. Airtable enforces that range rather than merely
 * documenting it, so a shorter verifier is rejected at the token exchange —
 * after the user has already authorized, which is the worst place to find out.
 */
const VERIFIER_BYTES = 32;

/** Whether a string is a legal `code_verifier`: the unreserved set, 43-128 long. */
export function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/**
 * The S256 transformation: base64url of the SHA-256 of the verifier's **ASCII
 * bytes**.
 *
 * Hashing the string rather than its ASCII bytes is the classic way to get this
 * subtly wrong; here the verifier is generated from the unreserved set, so the
 * two coincide, and `isValidVerifier` is what keeps that true for a verifier
 * that arrived from somewhere else.
 */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(): PkcePair {
  // base64url, so the output is already confined to the unreserved set and
  // needs no further encoding in a query string.
  const verifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}
