// The session cookie. The `__Host-` prefix requires `Secure`, `Path=/`, and no `Domain`, so the
// browser only sends it back to this exact origin over HTTPS.

export const SESSION_COOKIE = "__Host-session";

export function serializeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function serializeClearedSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

/** The session ID from a Cookie header, or undefined when there is none. */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}
