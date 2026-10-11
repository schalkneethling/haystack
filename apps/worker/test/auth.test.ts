import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import {
  generateSessionId,
  hashSessionId,
  SESSION_LIFETIME_MS,
} from "../src/auth/session-token.ts";

const ALLOWED = "Owner@Example.com, second@example.com";
const DAY = 24 * 60 * 60 * 1000;

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      vars: { ALLOWED_EMAILS: ALLOWED },
    },
  ],
});
let origin: string;

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

async function db() {
  return (await server.getWorker().getEnv()).DB;
}

beforeEach(async () => {
  const DB = await db();
  await DB.batch([DB.prepare("DELETE FROM sessions"), DB.prepare("DELETE FROM users")]);
});

// Seeds a user and a session that expires `expiresIn` ms from now. Returns the raw session ID.
async function seedSession(
  email: string,
  expiresIn: number,
): Promise<{ sessionId: string; idHash: string }> {
  const DB = await db();
  const userId = crypto.randomUUID();
  const sessionId = generateSessionId();
  const idHash = await hashSessionId(sessionId);
  const now = Date.now();
  await DB.batch([
    DB.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)").bind(
      userId,
      `sub-${userId}`,
      email,
      now,
    ),
    DB.prepare(
      "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(idHash, userId, now + expiresIn, now),
  ]);
  return { sessionId, idHash };
}

async function sessionExpiry(idHash: string): Promise<number | undefined> {
  const DB = await db();
  const row: { expires_at: number } | null = await DB.prepare(
    "SELECT expires_at FROM sessions WHERE id_hash = ?",
  )
    .bind(idHash)
    .first();
  return row?.expires_at;
}

function get(path: string, headers: Record<string, string> = {}) {
  return server.fetch(path, { headers, redirect: "manual" });
}

function cookieFor(sessionId: string) {
  return { cookie: `other=1; __Host-session=${sessionId}` };
}

const page = { accept: "text/html,application/xhtml+xml" };

describe("without a session", () => {
  it("redirects a page request to sign-in, with the page as the return target", async () => {
    const response = await get("/save?url=https%3A%2F%2Fexample.com%2F&title=A", page);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/save?url=https%3A%2F%2Fexample.com%2F&title=A")}`,
    );
  });

  it("redirects a HEAD page request to sign-in", async () => {
    const response = await server.fetch("/", { method: "HEAD", headers: page, redirect: "manual" });
    expect(response.status).toBe(302);
  });

  it("answers 401 to any other request", async () => {
    const response = await get("/api/search");
    expect(response.status).toBe(401);
  });

  it("reaches /auth/* routes", async () => {
    const response = await get("/auth/signed-out", page);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("You are signed out of Haystack.");
  });

  it("answers HEAD on an /auth/* page", async () => {
    const response = await server.fetch("/auth/signed-out", { method: "HEAD" });
    expect(response.status).toBe(200);
  });

  it("rejects a cookie that is not a stored session, and clears it", async () => {
    const response = await get("/", { ...page, ...cookieFor(generateSessionId()) });
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=; Max-Age=0");
  });
});

describe("with a session", () => {
  it("reaches the router", async () => {
    const { sessionId } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const response = await get("/", { ...page, ...cookieFor(sessionId) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("matches the allowlist case-insensitively", async () => {
    const { sessionId } = await seedSession("OWNER@example.COM", SESSION_LIFETIME_MS - DAY);
    expect((await get("/", cookieFor(sessionId))).status).toBe(404);
  });

  it("does not write in the first half of the session's life", async () => {
    const { sessionId, idHash } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const before = await sessionExpiry(idHash);
    const response = await get("/", cookieFor(sessionId));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await sessionExpiry(idHash)).toBe(before);
  });

  it("extends a session in the second half of its life", async () => {
    const { sessionId, idHash } = await seedSession("owner@example.com", 2 * DAY);
    const start = Date.now();
    const response = await get("/", cookieFor(sessionId));
    const expiresAt = await sessionExpiry(idHash);
    expect(expiresAt).toBeGreaterThanOrEqual(start + SESSION_LIFETIME_MS);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^__Host-session=${sessionId};`));
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toMatch(/Domain=/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(maxAge).toBeGreaterThan(SESSION_LIFETIME_MS / 1000 - 60);
    expect(maxAge).toBeLessThanOrEqual(SESSION_LIFETIME_MS / 1000);
  });

  it("rejects and deletes an expired session", async () => {
    const { sessionId, idHash } = await seedSession("owner@example.com", -1);
    const response = await get("/", { ...page, ...cookieFor(sessionId) });
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=; Max-Age=0");
    expect(await sessionExpiry(idHash)).toBeUndefined();
  });

  it("rejects and deletes the session of a user who is no longer allowed", async () => {
    const { sessionId, idHash } = await seedSession(
      "removed@example.com",
      SESSION_LIFETIME_MS - DAY,
    );
    const response = await get("/api/search", cookieFor(sessionId));
    expect(response.status).toBe(401);
    expect(await sessionExpiry(idHash)).toBeUndefined();
  });
});

describe("Origin check", () => {
  it.each([
    ["without an Origin header", {}],
    ["from another origin", { origin: "https://evil.example" }],
  ])("rejects a POST %s", async (_, headers) => {
    const response = await server.fetch("/auth/sign-out", {
      method: "POST",
      headers,
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin POST to an app route with a valid session", async () => {
    const { sessionId } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const response = await server.fetch("/bookmarks/1/delete", {
      method: "POST",
      headers: { origin: "https://evil.example", ...cookieFor(sessionId) },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("lets a same-origin POST to an app route reach the router", async () => {
    const { sessionId } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const response = await server.fetch("/bookmarks/1/delete", {
      method: "POST",
      headers: { origin, ...cookieFor(sessionId) },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  it("rejects a cross-origin POST even with a valid session", async () => {
    const { sessionId, idHash } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const response = await server.fetch("/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://evil.example", ...cookieFor(sessionId) },
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await sessionExpiry(idHash)).toBeDefined();
  });
});

describe("sign-out", () => {
  it("deletes the session, clears the cookie, and redirects", async () => {
    const { sessionId, idHash } = await seedSession("owner@example.com", SESSION_LIFETIME_MS - DAY);
    const response = await server.fetch("/auth/sign-out", {
      method: "POST",
      headers: { origin, ...cookieFor(sessionId) },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/signed-out");
    expect(response.headers.get("set-cookie")).toContain("__Host-session=; Max-Age=0");
    expect(await sessionExpiry(idHash)).toBeUndefined();
  });
});
