import { parseAllowedEmails } from "./auth/allowlist.ts";
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./auth/cookie.ts";
import { type AuthenticatedSession, authenticateSession, deleteSession } from "./auth/sessions.ts";
import { createDb, type Db } from "./db/client.ts";

// Until Phase 3 adds the escaping templating approach, responses are plain text and never
// interpolate user data.
function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function redirect(
  location: string,
  status: 302 | 303,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, { status, headers: { location, ...headers } });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF protection alongside SameSite: a state-changing request must come from this origin.
function isSameOriginRequest(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function isReadRequest(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function isPageRequest(request: Request): boolean {
  return isReadRequest(request) && (request.headers.get("accept") ?? "").includes("text/html");
}

async function handleAuthRoute(request: Request, db: Db, path: string): Promise<Response> {
  if (path === "/auth/sign-out" && request.method === "POST") {
    const sessionId = readSessionCookie(request.headers.get("cookie"));
    if (sessionId !== undefined) {
      await deleteSession(db, sessionId);
    }
    return redirect("/auth/signed-out", 303, { "set-cookie": serializeClearedSessionCookie() });
  }
  if (path === "/auth/signed-out" && isReadRequest(request)) {
    return text("You are signed out of Haystack.", 200);
  }
  if (path === "/auth/sign-in" && isReadRequest(request)) {
    // Google sign-in arrives in #26.
    return text("Sign-in is not available yet.", 501);
  }
  return text("Not found", 404);
}

// Routes that need a session. Each phase adds its own.
function handleAppRoute(_request: Request, _session: AuthenticatedSession): Response {
  return text("Not found", 404);
}

function unauthenticated(request: Request, hadCookie: boolean): Response {
  const headers: Record<string, string> = hadCookie
    ? { "set-cookie": serializeClearedSessionCookie() }
    : {};
  return isPageRequest(request)
    ? redirect("/auth/sign-in", 302, headers)
    : text("Unauthorized", 401, headers);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!SAFE_METHODS.has(request.method) && !isSameOriginRequest(request)) {
      return text("Forbidden", 403);
    }
    const db = createDb(env.DB);
    const path = new URL(request.url).pathname;
    if (path.startsWith("/auth/")) {
      return handleAuthRoute(request, db, path);
    }

    const now = Date.now();
    const sessionId = readSessionCookie(request.headers.get("cookie"));
    const session =
      sessionId === undefined
        ? undefined
        : await authenticateSession(db, sessionId, parseAllowedEmails(env.ALLOWED_EMAILS), now);
    if (sessionId === undefined || session === undefined) {
      return unauthenticated(request, sessionId !== undefined);
    }

    const response = handleAppRoute(request, session);
    if (!session.extended) {
      return response;
    }
    // A response from fetch() or Response.redirect() has immutable headers, so copy it first.
    const extended = new Response(response.body, response);
    const maxAgeSeconds = Math.floor((session.expiresAt - now) / 1000);
    extended.headers.append("set-cookie", serializeSessionCookie(sessionId, maxAgeSeconds));
    return extended;
  },
} satisfies ExportedHandler<Env>;
