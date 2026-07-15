import crypto from "node:crypto";

/**
 * PKCE (RFC 7636) + OAuth state helpers using node crypto.
 *
 * - code_verifier: high-entropy random string.
 * - code_challenge: base64url(SHA-256(code_verifier)), method S256.
 * - state: opaque CSRF token echoed back on the authorize redirect.
 */

/** base64url-encode a buffer (no padding). */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  /** Always "S256". */
  codeChallengeMethod: "S256";
}

/** Generate a PKCE verifier/challenge pair (S256). */
export function generatePkce(): PkcePair {
  // 32 random bytes → 43-char base64url verifier (within the 43..128 range).
  const codeVerifier = base64url(crypto.randomBytes(32));
  const digest = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(digest);
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

/** Generate an opaque OAuth `state` value for CSRF protection. */
export function generateState(): string {
  return base64url(crypto.randomBytes(16));
}
