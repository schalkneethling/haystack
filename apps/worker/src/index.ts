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
  bookmarkActionPath,
  type BookmarkRoute,
  HELD_PATH,
  SAVED_LINKS_PATH,
} from "./bookmark-paths.ts";
import { deleteBookmark, deleteReturnPage, readForm } from "./delete-bookmark.ts";
import { enrichOnSave } from "./enrichment/enrich-on-save.ts";
import { errorCode } from "./error-code.ts";
import { readReviewPolicy, releaseBookmark, retryBookmark, showHeld } from "./held.ts";
import { showRecentSaves } from "./recent-saves.ts";
import { runScheduled } from "./scheduled.ts";
import { showSearchPage } from "./search-page.ts";
import {
  saveBookmark,
  showSaveForm,
  type SignedOutSave,
  signedOutSave,
  signedOutSubmission,
} from "./save.ts";
import { saveAddress, signedOutAddress } from "./save-address.ts";
import { withSecurityHeaders } from "./security-headers.ts";
import {
  accountNotAllowedPage,
  notFoundPage,
  signedOutPage,
  signInFailedPage,
  signInLinkExpiredPage,
} from "./pages.ts";

// Plain text for API answers (401), blocked requests (403) and failures (500). Pages use
// htmlResponse. The entry point adds the security headers to every answer (security-headers.ts).
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

// A browser asks for HTML when it navigates, which is when it loads a page or submits a form.
// The site's scripts never do: the address form's asks for JSON, and the delete dialog's sends
// fetch()'s default, */*. So a POST that asks for HTML is a form submission, and one that does
// not is a script's, which gets a 401 it can act on (#34).
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/auth/callback`;
}

// The return target a sign-in stores. A save link is screened here as a signed-out /save is,
// because a URL that carries a secret is never stored (plan, decision 18), and a hand-built
// /auth/sign-in link never passes through /save. A save link that would get a page instead of
// the form falls back to the saved links, which have the address form, rather than ending the
// sign-in. A save link with no captured field, such as a bare /save, holds no value, so it is
// stored as `/save`, which shows the address form (plan, "Return targets"). A target off this
// origin falls back to `/` in safeReturnTarget.
function storedReturnTarget(request: Request, value: string | null): string {
  const target = safeReturnTarget(value);
  const url = new URL(target, request.url);
  if (url.pathname !== "/save") {
    return target;
  }
  const screened = signedOutSave(url);
  return "page" in screened ? SAVED_LINKS_PATH : screened.returnTo;
}

async function signIn(request: Request, env: Env, db: Db): Promise<Response> {
  const parameters = new URL(request.url).searchParams;
  const returnTo = storedReturnTarget(request, parameters.get("return_to"));
  const { state, codeChallenge } = await createAuthFlow(db, returnTo, Date.now());
  const location = authorizationUrl(
    env,
    redirectUri(request),
    state,
    codeChallenge,
    parameters.has("select_account"),
  );
  return redirect(location, 302, {
    "set-cookie": serializeAuthFlowCookie(state, AUTH_FLOW_LIFETIME_MS / 1000),
  });
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
  // /auth/* routes never look up a session, so this page has the signed-out header.
  return notFoundPage(false);
}

// A bookmark's own routes: Delete from any page that lists it, and Release and Retry from /held.
function handleBookmarkRoute(
  request: Request,
  env: Env,
  db: Db,
  userId: string,
  { bookmarkId, action }: BookmarkRoute,
): Promise<Response> {
  switch (action) {
    case "delete":
      return deleteBookmark(request, db, userId, bookmarkId, env);
    case "release":
      return releaseBookmark(request, db, userId, bookmarkId, env);
    case "retry":
      return retryBookmark(db, userId, bookmarkId, env);
  }
}

// Routes that need a session. Each phase adds its own.
async function handleAppRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  db: Db,
  session: AuthenticatedSession,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  // The search page is the home page (#206). /api/search has no route until #214, so a search
  // gets the 404 that every unknown route gets, and a deploy in between shows no results.
  if (path === "/" && isReadRequest(request)) {
    return showSearchPage();
  }
  if (path === SAVED_LINKS_PATH && isReadRequest(request)) {
    return showRecentSaves(db, session.user.id, env);
  }
  if (path === HELD_PATH && isReadRequest(request)) {
    return showHeld(db, session.user.id, readReviewPolicy(env));
  }
  if (path === "/save" && request.method === "GET") {
    return showSaveForm(request, db, session.user.id, env);
  }
  if (path === "/save" && request.method === "POST") {
    // A new bookmark is enriched straight away, without delaying the "Saved" page (#133). The
    // runtime keeps the Worker running for up to 30 seconds after the response for it, and the
    // on-save path never rejects (enrich-on-save.ts). Whatever it misses, the sweep enriches.
    return saveBookmark(request, db, session.user.id, env, (bookmark) => {
      ctx.waitUntil(enrichOnSave(db, env, bookmark));
    });
  }
  // The address form's Continue: the only route that fetches a page (plan, decision 2).
  if (path === "/save/address" && request.method === "POST") {
    return saveAddress(request, db, session.user.id);
  }
  const bookmarkRoute = request.method === "POST" ? bookmarkActionPath(path) : undefined;
  if (bookmarkRoute !== undefined) {
    return handleBookmarkRoute(request, env, db, session.user.id, bookmarkRoute);
  }
  return notFoundPage(true);
}

// Where sign-in returns to, or the page to show instead of signing in. A signed-out GET or HEAD
// /save is screened first, so a link that sign-in would not keep gets its page now, and no
// Location header carries a link the check flags (plan, "Sensitive URLs").
function beforeSignIn(request: Request): SignedOutSave {
  const url = new URL(request.url);
  if (url.pathname === "/save") {
    return signedOutSave(url);
  }
  return { returnTo: url.pathname + url.search };
}

// Where sign-in returns to after a form submission whose session had ended (#34), or the page to
// show instead. The save form returns to itself, with what the user entered, and the address
// form to the save form for its address. Both are screened as a signed-out GET /save is. A
// bookmark's buttons return to the page they were pressed on, because a POST cannot be repeated
// by returning to its path: Release and Retry to /held, and Delete to the page its form names.
// Any other form returns to the saved links.
async function afterSubmission(request: Request): Promise<SignedOutSave> {
  const path = new URL(request.url).pathname;
  if (path === "/save") {
    return signedOutSubmission(request);
  }
  if (path === "/save/address") {
    return signedOutAddress(request);
  }
  switch (bookmarkActionPath(path)?.action) {
    case "release":
    case "retry":
      return { returnTo: HELD_PATH };
    case "delete":
      return { returnTo: deleteReturnPage(await readForm(request)) };
    case undefined:
      return { returnTo: SAVED_LINKS_PATH };
  }
}

// A page request or a form submission is sent to sign-in. Every other request gets a 401. A
// form's 303 has the browser follow it with a GET, as a 302 after a GET does.
async function withoutSession(request: Request): Promise<Response> {
  const read = isReadRequest(request);
  if (!wantsHtml(request) || !(read || request.method === "POST")) {
    return text("Unauthorized", 401);
  }
  const next = read ? beforeSignIn(request) : await afterSubmission(request);
  if ("page" in next) {
    return next.page;
  }
  return redirect(`/auth/sign-in?return_to=${encodeURIComponent(next.returnTo)}`, read ? 302 : 303);
}

// Every answer clears a session cookie that is no longer valid.
async function unauthenticated(request: Request, hadCookie: boolean): Promise<Response> {
  const response = await withoutSession(request);
  if (hadCookie) {
    response.headers.append("set-cookie", serializeClearedSessionCookie());
  }
  return response;
}

// Every answer the Worker builds. The Origin check comes before anything else reads the request.
async function answer(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  const response = await handleAppRoute(request, env, ctx, db, session);
  if (!session.extended) {
    return response;
  }
  // A response from fetch() or Response.redirect() has immutable headers, so copy it first.
  const extended = new Response(response.body, response);
  const maxAgeSeconds = Math.floor((session.expiresAt - now) / 1000);
  extended.headers.append("set-cookie", serializeSessionCookie(sessionId, maxAgeSeconds));
  return extended;
}

export default {
  // Every answer leaves through here, so each one gets the security headers for its kind, and no
  // route can build one without them (#113). A route that throws, for example when D1 fails, gets
  // a 500 built here, because the runtime's own error page would leave without them. Only the
  // error's code is logged, never its message, which can hold a query's values.
  async fetch(request, env, ctx): Promise<Response> {
    let response: Response;
    try {
      response = await answer(request, env, ctx);
    } catch (error) {
      console.error("Request failed:", errorCode(error));
      response = text("Internal Server Error", 500);
    }
    return withSecurityHeaders(response);
  },
  // The Cron Trigger's run (`triggers.crons` in wrangler.jsonc): the enrichment sweep, then the
  // cleanup of expired sessions and sign-in flows (scheduled.ts). The runtime waits for the
  // promise a scheduled handler returns, so the run needs no `ctx.waitUntil`.
  async scheduled(_controller, env): Promise<void> {
    await runScheduled(env);
  },
} satisfies ExportedHandler<Env>;
