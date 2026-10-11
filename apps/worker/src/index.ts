import { parseAllowedEmails } from "./auth/allowlist.ts";
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./auth/cookie.ts";
import { consumeAuthFlow, createAuthFlow } from "./auth/auth-flows.ts";
import { authorizationUrl, completeSignIn } from "./auth/google.ts";
import { safeReturnTarget } from "./auth/return-target.ts";
import {
  type AuthenticatedSession,
  authenticateSession,
  createSession,
  deleteSession,
} from "./auth/sessions.ts";
import { upsertUser } from "./auth/users.ts";
import { isEmailAllowed } from "./auth/allowlist.ts";
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

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/auth/callback`;
}

async function signIn(request: Request, env: Env, db: Db): Promise<Response> {
  const returnTo = safeReturnTarget(new URL(request.url).searchParams.get("return_to"));
  const { state, codeChallenge } = await createAuthFlow(db, returnTo, Date.now());
  return redirect(authorizationUrl(env, redirectUri(request), state, codeChallenge), 302);
}

// Failures are logged by kind only: the callback URL carries the code and state.
async function callback(request: Request, env: Env, db: Db): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const now = Date.now();
  const flow = state === null ? undefined : await consumeAuthFlow(db, state, now);
  if (state === null || flow === undefined) {
    return text("This sign-in link has expired or was already used. Please sign in again.", 400);
  }
  let identity;
  try {
    identity = await completeSignIn(env, url, state, flow.codeVerifier, redirectUri(request));
  } catch (error) {
    console.error("Sign-in failed:", error instanceof Error ? error.name : "unknown error");
    return text("Sign-in failed. Please try again.", 400);
  }
  if (!isEmailAllowed(parseAllowedEmails(env.ALLOWED_EMAILS), identity.email)) {
    return text("This Google account is not allowed to use Haystack.", 403);
  }
  const userId = await upsertUser(db, identity, now);
  const { sessionId, expiresAt } = await createSession(db, userId, now);
  const maxAgeSeconds = Math.floor((expiresAt - now) / 1000);
  return redirect(safeReturnTarget(flow.returnTo), 302, {
    "set-cookie": serializeSessionCookie(sessionId, maxAgeSeconds),
  });
}

async function handleAuthRoute(
  request: Request,
  env: Env,
  db: Db,
  path: string,
): Promise<Response> {
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
  if (path === "/auth/sign-in" && request.method === "GET") {
    return signIn(request, env, db);
  }
  if (path === "/auth/callback" && request.method === "GET") {
    return callback(request, env, db);
  }
  return text("Not found", 404);
}

// Routes that need a session. Each phase adds its own.
function handleAppRoute(_request: Request, _session: AuthenticatedSession): Response {
  return text("Not found", 404);
}

function signInLocation(request: Request): string {
  const { pathname, search } = new URL(request.url);
  return `/auth/sign-in?return_to=${encodeURIComponent(pathname + search)}`;
}

function unauthenticated(request: Request, hadCookie: boolean): Response {
  const headers: Record<string, string> = hadCookie
    ? { "set-cookie": serializeClearedSessionCookie() }
    : {};
  return isPageRequest(request)
    ? redirect(signInLocation(request), 302, headers)
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
      return handleAuthRoute(request, env, db, path);
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
