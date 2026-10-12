import { isEmailAllowed, parseAllowedEmails } from "./auth/allowlist.ts";
import { AUTH_FLOW_LIFETIME_MS, consumeAuthFlow, createAuthFlow } from "./auth/auth-flows.ts";
import {
  readAuthFlowCookie,
  readSessionCookie,
  serializeAuthFlowCookie,
  serializeClearedAuthFlowCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./auth/cookie.ts";
import { authorizationUrl, completeSignIn } from "./auth/google.ts";
import { safeReturnTarget } from "./auth/return-target.ts";
import {
  type AuthenticatedSession,
  authenticateSession,
  createSession,
  deleteSession,
} from "./auth/sessions.ts";
import { upsertUser } from "./auth/users.ts";
import { createDb, type Db } from "./db/client.ts";
import {
  accountNotAllowedPage,
  notFoundPage,
  signedOutPage,
  signInFailedPage,
  signInLinkExpiredPage,
} from "./pages.ts";

// Plain text for API answers (401) and blocked requests (403). Pages use htmlResponse.
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
  return redirect(authorizationUrl(env, redirectUri(request), state, codeChallenge), 302, {
    "set-cookie": serializeAuthFlowCookie(state, AUTH_FLOW_LIFETIME_MS / 1000),
  });
}

// The error code is a fixed string (for example OAUTH_JWT_CLAIM_COMPARISON_FAILED). The message
// and cause are not logged, because they can contain the callback's parameters and claims.
function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}

async function completeCallback(request: Request, env: Env, db: Db): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  // Login CSRF: only the browser that started this sign-in may finish it. Checked before the
  // flow is consumed, so a forwarded link cannot use up the real user's flow.
  if (state === null || readAuthFlowCookie(request.headers.get("cookie")) !== state) {
    return signInLinkExpiredPage();
  }
  const now = Date.now();
  const flow = await consumeAuthFlow(db, state, now);
  if (flow === undefined) {
    return signInLinkExpiredPage();
  }
  let identity;
  try {
    identity = await completeSignIn(env, url, state, flow.codeVerifier, redirectUri(request));
  } catch (error) {
    console.error("Sign-in failed:", errorCode(error));
    return signInFailedPage();
  }
  if (!isEmailAllowed(parseAllowedEmails(env.ALLOWED_EMAILS), identity.email)) {
    return accountNotAllowedPage();
  }
  // A browser that was already signed in drops its old session rather than leaving it behind.
  const previousSessionId = readSessionCookie(request.headers.get("cookie"));
  if (previousSessionId !== undefined) {
    await deleteSession(db, previousSessionId);
  }
  const userId = await upsertUser(db, identity, now);
  const { sessionId, expiresAt } = await createSession(db, userId, now);
  const maxAgeSeconds = Math.floor((expiresAt - now) / 1000);
  return redirect(safeReturnTarget(flow.returnTo), 302, {
    "set-cookie": serializeSessionCookie(sessionId, maxAgeSeconds),
  });
}

// Every callback outcome clears the flow cookie: a flow is never retried.
async function callback(request: Request, env: Env, db: Db): Promise<Response> {
  const response = await completeCallback(request, env, db);
  response.headers.append("set-cookie", serializeClearedAuthFlowCookie());
  return response;
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
    return signedOutPage();
  }
  if (path === "/auth/sign-in" && request.method === "GET") {
    return signIn(request, env, db);
  }
  if (path === "/auth/callback" && request.method === "GET") {
    return callback(request, env, db);
  }
  return notFoundPage();
}

// Routes that need a session. Each phase adds its own.
function handleAppRoute(_request: Request, _session: AuthenticatedSession): Response {
  return notFoundPage();
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
