// Google sign-in through the real Worker, with a fixture server standing in for Google's token
// and keys endpoints. The test plays the browser: it follows /auth/sign-in to the authorization
// URL, then calls /auth/callback with a code the fixture knows.
import type { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

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

let server: ReturnType<typeof createTestHarness>;

beforeAll(async () => {
  googleKey = await generateKey();
  otherKey = await generateKey();
  await startFixture();
  server = createTestHarness({
    workers: [
      {
        configPath: new URL("../wrangler.jsonc", import.meta.url),
        vars: {
          ALLOWED_EMAILS: "owner@example.com, second@example.com",
          GOOGLE_CLIENT_ID: CLIENT_ID,
          GOOGLE_ISSUER: ISSUER,
          GOOGLE_AUTHORIZATION_ENDPOINT: `${fixtureOrigin}/authorize`,
          GOOGLE_TOKEN_ENDPOINT: `${fixtureOrigin}/token`,
          GOOGLE_JWKS_URI: `${fixtureOrigin}/jwks`,
        },
        secrets: { GOOGLE_CLIENT_SECRET: CLIENT_SECRET },
      },
    ],
  });
  await server.listen();
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

// Starts sign-in and returns the authorization request parameters the Worker sent to "Google".
async function startSignIn(returnTo?: string): Promise<URLSearchParams> {
  const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`;
  const response = await server.fetch(`/auth/sign-in${query}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${fixtureOrigin}/authorize`);
  return location.searchParams;
}

interface CallbackOptions {
  claims?: Record<string, unknown>;
  signingKey?: CryptoKey;
  codeChallenge?: string;
}

// Plays Google's side: registers a code, then sends the browser back to the callback.
async function callBack(authorization: URLSearchParams, options: CallbackOptions = {}) {
  const code = crypto.randomUUID();
  codes.set(code, {
    codeChallenge: options.codeChallenge ?? authorization.get("code_challenge") ?? "",
    claims: options.claims ?? idTokenClaims(),
    signingKey: options.signingKey ?? googleKey.privateKey,
  });
  const state = authorization.get("state") ?? "";
  return server.fetch(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
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
    const authorization = await startSignIn();
    expect(authorization.get("client_id")).toBe(CLIENT_ID);
    expect(authorization.get("response_type")).toBe("code");
    expect(authorization.get("scope")).toBe("openid email");
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new URL(authorization.get("redirect_uri") ?? "").pathname).toBe("/auth/callback");
  });
});

describe("a successful sign-in", () => {
  it("creates the user and a session, and redirects to the return target", async () => {
    const response = await callBack(await startSignIn("/save?url=https%3A%2F%2Fexample.com%2F"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/save?url=https%3A%2F%2Fexample.com%2F");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-session=[A-Za-z0-9_-]{43}; Max-Age=2592000;/,
    );
    expect(await counts()).toEqual({ users: 1, sessions: 1 });

    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const app = await server.fetch("/", { headers: { cookie }, redirect: "manual" });
    expect(app.status).toBe(404);
  });

  it("keeps a return target longer than 4 KB", async () => {
    const returnTo = `/save?title=${"a".repeat(5000)}`;
    const response = await callBack(await startSignIn(returnTo));
    expect(response.headers.get("location")).toBe(returnTo);
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "save",
  ])("falls back to / for the return target %j", async (returnTo) => {
    const response = await callBack(await startSignIn(returnTo));
    expect(response.headers.get("location")).toBe("/");
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

describe("a rejected sign-in", () => {
  async function expectRejected(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await counts()).toEqual({ users: 0, sessions: 0 });
  }

  it("rejects an unknown state", async () => {
    const authorization = new URLSearchParams({ state: "unknown", code_challenge: "x" });
    await expectRejected(await callBack(authorization), 400);
  });

  it("rejects a state that was already used", async () => {
    const authorization = await startSignIn();
    expect((await callBack(authorization)).status).toBe(302);
    const DB = await db();
    await DB.batch([DB.prepare("DELETE FROM sessions"), DB.prepare("DELETE FROM users")]);
    await expectRejected(await callBack(authorization), 400);
  });

  it("rejects an expired state", async () => {
    const authorization = await startSignIn();
    await (
      await db()
    )
      .prepare("UPDATE auth_flows SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await expectRejected(await callBack(authorization), 400);
  });

  it("rejects a code exchanged with the wrong PKCE verifier", async () => {
    const authorization = await startSignIn();
    await expectRejected(
      await callBack(authorization, { codeChallenge: await s256("another verifier") }),
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
