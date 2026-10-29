// Google sign-in through the real Worker, with a fixture server standing in for Google's token
// and keys endpoints. The test plays the browser: it follows /auth/sign-in to the authorization
// URL, then calls /auth/callback with a code the fixture knows.
import type { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestWorker, type TestWorker } from "./test-worker.ts";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const ISSUER = "https://accounts.google.com";
const KEY_ID = "test-key";

// The test tsconfig has Node types, not the DOM lib, so Web Crypto types come from node:crypto.
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url",
  );
}

async function generateKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function signJwt(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" })),
  );
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

async function s256(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  claims: Record<string, unknown>;
  signingKey: CryptoKey;
}

let googleKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
const codes = new Map<string, PendingCode>();
let fixture: Server;
let fixtureOrigin: string;

// The fixture's token endpoint does what Google's does for these tests: it checks the client,
// the redirect URI, and the PKCE verifier against the challenge from the authorization request.
function startFixture(): Promise<void> {
  fixture = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/jwks") {
      const jwk = await crypto.subtle.exportKey("jwk", googleKey.publicKey);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] }));
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const form = new URLSearchParams(body);
      const pending = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const valid =
        pending !== undefined &&
        form.get("grant_type") === "authorization_code" &&
        form.get("client_id") === CLIENT_ID &&
        form.get("client_secret") === CLIENT_SECRET &&
        form.get("redirect_uri") === pending.redirectUri &&
        (await s256(verifier)) === pending.codeChallenge;
      if (!valid) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: await signJwt(pending.signingKey, pending.claims),
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    fixture.listen(0, "127.0.0.1", () => {
      fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

// The Worker under test, with the given Google client secret.
function createWorker(clientSecret: string): TestWorker {
  return createTestWorker({
    vars: {
      ALLOWED_EMAILS: "owner@example.com, second@example.com",
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_ISSUER: ISSUER,
      GOOGLE_AUTHORIZATION_ENDPOINT: `${fixtureOrigin}/authorize`,
      GOOGLE_TOKEN_ENDPOINT: `${fixtureOrigin}/token`,
      GOOGLE_JWKS_URI: `${fixtureOrigin}/jwks`,
    },
    secrets: { GOOGLE_CLIENT_SECRET: clientSecret },
  });
}

let server: TestWorker;
let workerOrigin: string;

beforeAll(async () => {
  googleKey = await generateKey();
  otherKey = await generateKey();
  await startFixture();
  server = createWorker(CLIENT_SECRET);
  workerOrigin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
  await new Promise((resolve) => fixture.close(resolve));
});

async function db() {
  return (await server.getWorker().getEnv()).DB;
}

beforeEach(async () => {
  const DB = await db();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
    DB.prepare("DELETE FROM auth_flows"),
  ]);
  codes.clear();
});

function idTokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "google-sub-1",
    email: "owner@example.com",
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

interface SignInStart {
  authorization: URLSearchParams;
  // The browser's binding cookie, as `name=value`.
  flowCookie: string;
}

// Starts sign-in and returns what the Worker sent to "Google", and the cookie it set.
async function startSignIn(returnTo?: string): Promise<SignInStart> {
  const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
  const response = await server.fetch(`/auth/sign-in${query}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${fixtureOrigin}/authorize`);
  const flowCookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { authorization: location.searchParams, flowCookie };
}

interface CallbackOptions {
  claims?: Record<string, unknown>;
  signingKey?: CryptoKey;
  codeChallenge?: string;
  // The Cookie header the browser sends. Defaults to the flow cookie from startSignIn.
  cookie?: string | null;
}

// Plays Google's side: registers a code, then sends the browser back to the callback.
async function callBack({ authorization, flowCookie }: SignInStart, options: CallbackOptions = {}) {
  const code = crypto.randomUUID();
  codes.set(code, {
    codeChallenge: options.codeChallenge ?? authorization.get("code_challenge") ?? "",
    redirectUri: authorization.get("redirect_uri") ?? "",
    claims: options.claims ?? idTokenClaims(),
    signingKey: options.signingKey ?? googleKey.privateKey,
  });
  const state = authorization.get("state") ?? "";
  const cookie = options.cookie === undefined ? flowCookie : options.cookie;
  return server.fetch(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    headers: cookie === null ? {} : { cookie },
    redirect: "manual",
  });
}

async function counts(): Promise<{ users: number; sessions: number }> {
  const DB = await db();
  const [users, sessions] = await DB.batch([
    DB.prepare("SELECT count(*) AS n FROM users"),
    DB.prepare("SELECT count(*) AS n FROM sessions"),
  ]);
  return { users: users.results[0].n, sessions: sessions.results[0].n };
}

describe("authorization request", () => {
  it("uses PKCE with S256, the configured client, and the callback as redirect URI", async () => {
    const { authorization } = await startSignIn();
    expect(authorization.get("client_id")).toBe(CLIENT_ID);
    expect(authorization.get("response_type")).toBe("code");
    expect(authorization.get("scope")).toBe("openid email");
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorization.get("redirect_uri")).toBe(`${workerOrigin}/auth/callback`);
  });

  it("asks Google to show the account chooser only when requested", async () => {
    const plain = await server.fetch("/auth/sign-in", { redirect: "manual" });
    expect(new URL(plain.headers.get("location") ?? "").searchParams.has("prompt")).toBe(false);
    const chooser = await server.fetch("/auth/sign-in?select_account", { redirect: "manual" });
    expect(new URL(chooser.headers.get("location") ?? "").searchParams.get("prompt")).toBe(
      "select_account",
    );
  });

  it("binds the flow to the browser with a short-lived cookie", async () => {
    const response = await server.fetch("/auth/sign-in", { redirect: "manual" });
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state");
    expect(response.headers.get("set-cookie")).toBe(
      `__Host-auth_flow=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  });
});

describe("a successful sign-in", () => {
  it("creates the user and a session, and redirects to the return target", async () => {
    const response = await callBack(await startSignIn("/save?url=https%3A%2F%2Fexample.com%2F"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/save?url=https%3A%2F%2Fexample.com%2F");
    expect(response.headers.get("set-cookie")).toContain("__Host-auth_flow=; Max-Age=0");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-session=[A-Za-z0-9_-]{43}; Max-Age=2592000;/,
    );
    expect(await counts()).toEqual({ users: 1, sessions: 1 });

    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const app = await server.fetch("/saved-links", { headers: { cookie }, redirect: "manual" });
    expect(app.status).toBe(200);
  });

  it("keeps a return target longer than 4 KB", async () => {
    // A valid save link, because sign-in screens one and would not keep an invalid one.
    const address = `https://example.com/${"a".repeat(2000)}`;
    const returnTo = `/save?${new URLSearchParams({
      url: address,
      canonical_url: address,
      title: "a".repeat(200),
    }).toString()}`;
    expect(returnTo.length).toBeGreaterThan(4096);
    const response = await callBack(await startSignIn(returnTo));
    expect(response.headers.get("location")).toBe(returnTo);
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/.//evil.example/",
    "/a/..//evil.example/",
    "/%2e%2e//evil.example/",
    "/.\\/evil.example/",
    "save",
  ])("falls back to / for the return target %j", async (returnTo) => {
    const response = await callBack(await startSignIn(returnTo));
    expect(response.headers.get("location")).toBe("/");
  });

  it("lands on the home page without a return target", async () => {
    const response = await callBack(await startSignIn());
    expect(response.headers.get("location")).toBe("/");
  });

  it("removes the session the browser already had", async () => {
    const first = await callBack(await startSignIn());
    const oldCookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const start = await startSignIn();
    await callBack(start, { cookie: `${oldCookie}; ${start.flowCookie}` });
    expect((await counts()).sessions).toBe(1);
    const app = await server.fetch("/api/search", { headers: { cookie: oldCookie } });
    expect(app.status).toBe(401);
  });

  it("matches a returning user by sub and updates their email", async () => {
    await callBack(await startSignIn(), { claims: idTokenClaims({ email: "owner@example.com" }) });
    await callBack(await startSignIn(), { claims: idTokenClaims({ email: "second@example.com" }) });
    const DB = await db();
    const { results } = await DB.prepare("SELECT email FROM users").all();
    expect(results).toEqual([{ email: "second@example.com" }]);
    expect((await counts()).sessions).toBe(2);
  });
});

// A signed-out /save link is screened before the redirect, so a flagged canonical URL never
// becomes part of the stored return target (plan, "Sensitive URLs").
describe("signing in from a signed-out save link", () => {
  const clean = {
    url: "https://example.com/article",
    canonical_url: "https://example.com/article",
    title: "An article",
  };

  it.each([
    ["a clean link", clean, clean],
    // The flag that a canonical URL was dropped (#131) takes the dropped URL's place, so the
    // form after sign-in still knows that the page declared one.
    [
      "a flagged canonical URL",
      { ...clean, canonical_url: "https://example.com/article?access_token=secret-value" },
      { url: clean.url, title: clean.title, sensitive_canonical_dropped: "1" },
    ],
    [
      "the flag that a canonical URL was dropped",
      { url: clean.url, title: clean.title, sensitive_canonical_dropped: "1" },
      { url: clean.url, title: clean.title, sensitive_canonical_dropped: "1" },
    ],
    ["a flag with a value other than 1", { ...clean, sensitive_canonical_dropped: "yes" }, clean],
  ])("returns to the save form for %s", async (_, fields, expected) => {
    const toSignIn = await server.fetch(`/save?${new URLSearchParams(fields).toString()}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    const location = new URL(toSignIn.headers.get("location") ?? "", workerOrigin);
    const returnTo = location.searchParams.get("return_to") ?? "";
    expect(returnTo).toBe(`/save?${new URLSearchParams(expected).toString()}`);

    const start = await startSignIn(returnTo);
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    expect(results).toEqual([{ return_to: returnTo }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe(returnTo);

    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const form = await server.fetch(returnTo, {
      headers: { accept: "text/html", cookie },
      redirect: "manual",
    });
    expect(form.status).toBe(200);
    const markup = await form.text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
    expect(markup.includes('name="canonical_url"')).toBe("canonical_url" in expected);
    // The form after sign-in carries the flag as a hidden input, for POST /save to store.
    expect(markup.includes('name="sensitive_canonical_dropped" value="1"')).toBe(
      "sensitive_canonical_dropped" in expected,
    );
    expect(markup).not.toContain("secret-value");
  });
});

// The save form submitted after the session ended (#34): the user signs in and lands on the same
// form, with what they entered, and pressing Save there saves it.
describe("signing in from the save form submitted without a session", () => {
  it("returns to the form with the values entered, which then save", async () => {
    const fields = {
      url: "https://example.com/article",
      title: "An article",
      confirmed_title: "My title",
      confirmed_description: "My notes",
    };
    const submitted = await server.fetch("/save", {
      method: "POST",
      headers: { origin: workerOrigin, accept: "text/html,application/xhtml+xml" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);
    const location = new URL(submitted.headers.get("location") ?? "", workerOrigin);
    const returnTo = location.searchParams.get("return_to") ?? "";
    expect(returnTo).toBe(`/save?${new URLSearchParams(fields).toString()}`);

    // Sign-in screens the save link again, and stores the same target.
    const start = await startSignIn(returnTo);
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    expect(results).toEqual([{ return_to: returnTo }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe(returnTo);

    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const form = await (
      await server.fetch(returnTo, { headers: { accept: "text/html", cookie }, redirect: "manual" })
    ).text();
    expect(form).toContain("This link is not saved yet.");
    expect(form).toContain('value="My title"');
    expect(form).toContain(">My notes</textarea>");

    // The form posts its own fields, which the browser sends as it did the first time.
    const saved = await server.fetch("/save", {
      method: "POST",
      headers: { origin: workerOrigin, accept: "text/html", cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    expect(await saved.text()).toContain("<h1>Saved</h1>");
    const bookmark = await (await db()).prepare("SELECT title, description FROM bookmarks").first();
    expect(bookmark).toEqual({ title: "My title", description: "My notes" });
  });
});

// A bare /save is the address form (#97). Signed out, it sends the user to sign in, and they
// land on the form afterwards.
describe("signing in from a signed-out bare /save", () => {
  it("returns to the address form", async () => {
    const toSignIn = await server.fetch("/save", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(toSignIn.status).toBe(302);
    const location = new URL(toSignIn.headers.get("location") ?? "", workerOrigin);
    expect(location.pathname).toBe("/auth/sign-in");
    const returnTo = location.searchParams.get("return_to") ?? "";
    expect(returnTo).toBe("/save");

    const start = await startSignIn(returnTo);
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    expect(results).toEqual([{ return_to: "/save" }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe("/save");

    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const form = await server.fetch("/save", {
      headers: { accept: "text/html", cookie },
      redirect: "manual",
    });
    expect(form.status).toBe(200);
    const markup = await form.text();
    expect(markup).toContain('<h1><label for="save-url">Save a link</label></h1>');
    expect(markup).toMatch(/<input id="save-url"[^>]* name="url" type="url"/);
  });
});

// A hand-built sign-in link skips the check on /save, so sign-in screens a save link itself
// before it stores it (plan, "Return targets").
describe("a save link given to sign-in directly", () => {
  async function storedReturnTargets(): Promise<unknown[]> {
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    return results;
  }

  const article = "https://example.com/article";

  it.each([
    ["an access token", { url: `${article}?access_token=secret-value` }],
    ["a signed storage URL", { url: `${article}?X-Amz-Signature=secret-value&X-Amz-Credential=a` }],
    ["embedded credentials", { url: "https://user:secret-value@example.com/" }],
    [
      "a title over its cap, so the address is never checked",
      { url: `${article}?access_token=secret-value`, title: "a".repeat(201) },
    ],
    ["an http address", { url: "http://example.com/?access_token=secret-value" }],
  ])("stores the saved links for a link with %s, and returns there", async (_, fields) => {
    const start = await startSignIn(`/save?${new URLSearchParams(fields).toString()}`);
    expect(await storedReturnTargets()).toEqual([{ return_to: "/saved-links" }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe("/saved-links");
  });

  // safeReturnTarget resolves dot segments and drops tabs before sign-in reads the path, so the
  // path it compares is the one the router compares.
  it.each(["/x/../save", "/./save", "/sa\tve"])(
    "screens a save link written as %j",
    async (path) => {
      await startSignIn(
        `${path}?url=${encodeURIComponent(`${article}?access_token=secret-value`)}`,
      );
      expect(await storedReturnTargets()).toEqual([{ return_to: "/saved-links" }]);
    },
  );

  // A link with no captured field holds no value, so it is stored as the bare path, which shows
  // the address form (#97). Before #97 a bare /save got the validation page, so it fell back to /.
  it.each(["/save", "/save?", "/save?note=secret-value", "/save#access_token=secret-value"])(
    "stores /save for %j, which carries no captured field",
    async (returnTo) => {
      await startSignIn(returnTo);
      expect(await storedReturnTargets()).toEqual([{ return_to: "/save" }]);
    },
  );

  it("stores the flag in place of a flagged canonical URL, and not the URL", async () => {
    const returnTo = `/save?url=${encodeURIComponent(article)}&canonical_url=${encodeURIComponent(`${article}?access_token=secret-value`)}`;
    const start = await startSignIn(returnTo);
    const expected = `/save?${new URLSearchParams({ url: article, sensitive_canonical_dropped: "1" }).toString()}`;
    expect(await storedReturnTargets()).toEqual([{ return_to: expected }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe(expected);
  });

  it.each([
    [
      "a second url",
      `/save?url=${encodeURIComponent(article)}&url=${encodeURIComponent(`${article}?access_token=secret-value`)}`,
    ],
    ["an unknown key", `/save?url=${encodeURIComponent(article)}&token=secret-value`],
    ["a fragment", `/save?url=${encodeURIComponent(article)}#access_token=secret-value`],
  ])("stores only the screened fields for a link with %s", async (_, returnTo) => {
    const start = await startSignIn(returnTo);
    const expected = `/save?${new URLSearchParams({ url: article }).toString()}`;
    expect(await storedReturnTargets()).toEqual([{ return_to: expected }]);
    const signedIn = await callBack(start);
    expect(signedIn.headers.get("location")).toBe(expected);
  });

  it.each([
    `/save?${new URLSearchParams({ url: article, canonical_url: article, title: "An article" }).toString()}`,
    "/?view=recent#bookmark-1",
  ])("stores %j as given", async (returnTo) => {
    await startSignIn(returnTo);
    expect(await storedReturnTargets()).toEqual([{ return_to: returnTo }]);
  });
});

describe("a rejected sign-in", () => {
  async function expectRejected(response: Response, status: number) {
    expect(response.status).toBe(status);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).not.toContain("__Host-session=");
    expect(cookies).toContain("__Host-auth_flow=; Max-Age=0");
    expect(await counts()).toEqual({ users: 0, sessions: 0 });
  }

  it("rejects an unknown state", async () => {
    const authorization = new URLSearchParams({ state: "unknown", code_challenge: "x" });
    const start = { authorization, flowCookie: "__Host-auth_flow=unknown" };
    await expectRejected(await callBack(start), 400);
  });

  it.each([
    ["without the flow cookie", null],
    ["with another flow's cookie", "__Host-auth_flow=another-state"],
  ])("rejects a callback %s (login CSRF), and leaves the flow usable", async (_, cookie) => {
    const start = await startSignIn();
    await expectRejected(await callBack(start, { cookie }), 400);
    expect((await callBack(start)).status).toBe(302);
  });

  it("clears the flow cookie when the callback fails", async () => {
    const start = await startSignIn();
    const response = await callBack(start, { claims: idTokenClaims({ aud: "another-client" }) });
    expect(response.headers.get("set-cookie")).toContain("__Host-auth_flow=; Max-Age=0");
  });

  it("rejects a state that was already used", async () => {
    const start = await startSignIn();
    expect((await callBack(start)).status).toBe(302);
    const DB = await db();
    await DB.batch([DB.prepare("DELETE FROM sessions"), DB.prepare("DELETE FROM users")]);
    await expectRejected(await callBack(start), 400);
  });

  it("rejects an expired state", async () => {
    const start = await startSignIn();
    await (
      await db()
    )
      .prepare("UPDATE auth_flows SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await expectRejected(await callBack(start), 400);
  });

  it("rejects a code exchanged with the wrong PKCE verifier", async () => {
    const start = await startSignIn();
    await expectRejected(
      await callBack(start, { codeChallenge: await s256("another verifier") }),
      400,
    );
  });

  it.each([
    ["the wrong audience", { aud: "another-client" }],
    ["the wrong issuer", { iss: "https://evil.example" }],
    [
      "an expired token",
      { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 4200 },
    ],
    ["an unverified email", { email_verified: false }],
    ["no email", { email: undefined }],
  ])("rejects an ID token with %s", async (_, overrides) => {
    await expectRejected(
      await callBack(await startSignIn(), { claims: idTokenClaims(overrides) }),
      400,
    );
  });

  it("rejects an ID token signed with another key", async () => {
    await expectRejected(
      await callBack(await startSignIn(), { signingKey: otherKey.privateKey }),
      400,
    );
  });

  it("rejects an account that is not on the allowlist", async () => {
    const response = await callBack(await startSignIn(), {
      claims: idTokenClaims({ email: "stranger@example.com" }),
    });
    await expectRejected(response, 403);
    expect(await response.text()).not.toContain("stranger@example.com");
  });
});

describe("a Worker whose Google client secret is empty", () => {
  let emptySecretServer: TestWorker;

  beforeAll(async () => {
    emptySecretServer = createWorker("");
    await emptySecretServer.listen();
    await emptySecretServer.getWorker().applyD1Migrations("DB");
  });

  afterAll(async () => {
    await emptySecretServer.close();
  });

  it("shows the sign-in failed page, names the empty secret in the log, and clears the flow cookie", async () => {
    const start = await emptySecretServer.fetch("/auth/sign-in", { redirect: "manual" });
    emptySecretServer.clearLogs();
    const authorization = new URL(start.headers.get("location") ?? "").searchParams;
    const flowCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const response = await emptySecretServer.fetch(
      `/auth/callback?code=unused&state=${encodeURIComponent(authorization.get("state") ?? "")}`,
      { headers: { cookie: flowCookie }, redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Sign-in failed");
    expect(response.headers.get("set-cookie")).toContain("__Host-auth_flow=; Max-Age=0");
    expect(emptySecretServer.getLogs()).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Sign-in failed: GOOGLE_CLIENT_SECRET_EMPTY",
      }),
    );
  });
});
