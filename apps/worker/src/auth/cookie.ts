// Cookies. The `__Host-` prefix requires `Secure`, `Path=/`, and no `Domain`, so the browser only
// sends a cookie back to this exact origin over HTTPS.

export const SESSION_COOKIE = "__Host-session";

// Binds a sign-in to the browser that started it: the callback accepts a `state` only from the
// browser holding this cookie (login CSRF protection, RFC 9700 section 4.7.1). SameSite=Lax
// still sends it on Google's top-level redirect back to the callback.
export const AUTH_FLOW_COOKIE = "__Host-auth_flow";

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** The value of the named cookie in a Cookie header, or undefined when absent or empty. */
function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (cookieHeader === null) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

export function serializeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return serializeCookie(SESSION_COOKIE, sessionId, maxAgeSeconds);
}

export function serializeClearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", 0);
}

/** The session ID from a Cookie header, or undefined when there is none. */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  return readCookie(cookieHeader, SESSION_COOKIE);
}

export function serializeAuthFlowCookie(state: string, maxAgeSeconds: number): string {
  return serializeCookie(AUTH_FLOW_COOKIE, state, maxAgeSeconds);
}

export function serializeClearedAuthFlowCookie(): string {
  return serializeCookie(AUTH_FLOW_COOKIE, "", 0);
}

export function readAuthFlowCookie(cookieHeader: string | null): string | undefined {
  return readCookie(cookieHeader, AUTH_FLOW_COOKIE);
}
