// Pure helpers for session IDs. The raw ID lives only in the cookie; the database stores its
// SHA-256 hash, so a database leak does not expose usable session IDs.

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A new session ID: 32 random bytes, base64url-encoded. */
export function generateSessionId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The hex SHA-256 hash of a session ID, as stored in `sessions.id_hash`. */
export async function hashSessionId(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sessions slide: a request in the second half of a session's life extends it, so the
 * database is not written on every request.
 */
export function shouldExtendSession(expiresAt: number, now: number): boolean {
  return expiresAt - now < SESSION_LIFETIME_MS / 2;
}
