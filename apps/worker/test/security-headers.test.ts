// The security headers on every answer the Worker builds (#113; plan, "Untrusted content"). The
// entry point adds them to whatever a route returns, so a route cannot leave them out. This test
// walks every route in src/index.ts, in each state that gives a different kind of answer, and
// checks that each answer has exactly the headers for its kind. The 401, the 403 and the
// redirects are built with no security header of their own, so if any answer left the Worker
// without the entry point's step, its case here would fail.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { withSecurityHeaders } from "../src/security-headers.ts";
import { seedSignedInUser, type SeededUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// What each kind of answer carries. Every name is listed for every kind, so a header that does
// not belong on a kind is checked to be absent.
const EXPECTED = {
  page: {
    "content-security-policy": PAGE_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",
  },
  body: {
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": null,
    "cache-control": "no-store",
  },
  redirect: {
    "content-security-policy": null,
    "x-content-type-options": null,
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",
  },
} as const;

type Kind = keyof typeof EXPECTED;

function expectHeadersFor(response: Response, kind: Kind): void {
  for (const [name, value] of Object.entries(EXPECTED[kind])) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

const server = createTestWorker({ vars: { ALLOWED_EMAILS: "owner@example.com" } });
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

let owner: SeededUser;

beforeEach(async () => {
  const DB = await db();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

const HTML = { accept: "text/html,application/xhtml+xml" };
const JSON_ACCEPT = { accept: "application/json" };

interface Case {
  name: string;
  method?: "GET" | "HEAD" | "POST";
  path: string;
  headers?: Record<string, string>;
  // A form body, sent with the request's own origin unless `crossOrigin` is set. A function
  // builds it once the Worker's origin is known.
  body?: Record<string, string> | (() => Record<string, string>);
  signedIn: boolean;
  crossOrigin?: boolean;
  status: number;
  kind: Kind;
}

const saveForm = {
  url: "https://example.com/article",
  title: "An article",
  confirmed_title: "An article",
  confirmed_description: "",
};

// An address on the Worker's own host, which POST /save/address answers without looking it up,
// so no case makes a request to the internet.
function ownAddress(): Record<string, string> {
  return { url: `https://${new URL(origin).host}/page` };
}

const cases: Case[] = [
  // Signed out.
  {
    name: "a page request",
    path: "/",
    headers: HTML,
    signedIn: false,
    status: 302,
    kind: "redirect",
  },
  {
    name: "a HEAD page request",
    method: "HEAD",
    path: "/",
    headers: HTML,
    signedIn: false,
    status: 302,
    kind: "redirect",
  },
  {
    name: "a rejected save link",
    path: "/save?url=http%3A%2F%2Fexample.com%2F",
    headers: HTML,
    signedIn: false,
    status: 400,
    kind: "page",
  },
  {
    name: "the save form's submission",
    method: "POST",
    path: "/save",
    headers: HTML,
    body: saveForm,
    signedIn: false,
    status: 303,
    kind: "redirect",
  },
  {
    name: "the address form's submission",
    method: "POST",
    path: "/save/address",
    headers: HTML,
    body: ownAddress,
    signedIn: false,
    status: 303,
    kind: "redirect",
  },
  {
    name: "a Delete button's submission",
    method: "POST",
    path: "/bookmarks/1/delete",
    headers: HTML,
    body: { confirm: "yes" },
    signedIn: false,
    status: 303,
    kind: "redirect",
  },
  {
    name: "a script's POST /save",
    method: "POST",
    path: "/save",
    body: saveForm,
    signedIn: false,
    status: 401,
    kind: "body",
  },
  {
    name: "the address form script's POST",
    method: "POST",
    path: "/save/address",
    headers: JSON_ACCEPT,
    body: ownAddress,
    signedIn: false,
    status: 401,
    kind: "body",
  },
  {
    name: "an API request",
    path: "/api/search",
    signedIn: false,
    status: 401,
    kind: "body",
  },
  {
    name: "a cross-origin form submission",
    method: "POST",
    path: "/save",
    headers: HTML,
    body: saveForm,
    crossOrigin: true,
    signedIn: false,
    status: 403,
    kind: "body",
  },
  {
    name: "a cross-origin sign-out",
    method: "POST",
    path: "/auth/sign-out",
    crossOrigin: true,
    signedIn: false,
    status: 403,
    kind: "body",
  },
  {
    name: "the signed-out page",
    path: "/auth/signed-out",
    signedIn: false,
    status: 200,
    kind: "page",
  },
  {
    name: "an unknown /auth/* route",
    path: "/auth/unknown",
    signedIn: false,
    status: 404,
    kind: "page",
  },
  {
    name: "a callback with no flow",
    path: "/auth/callback?code=c&state=s",
    signedIn: false,
    status: 400,
    kind: "page",
  },
  {
    name: "the start of sign-in",
    path: "/auth/sign-in",
    signedIn: false,
    status: 302,
    kind: "redirect",
  },
  // Signed in.
  {
    name: "sign-out",
    method: "POST",
    path: "/auth/sign-out",
    signedIn: true,
    status: 303,
    kind: "redirect",
  },
  {
    name: "the saved links",
    path: "/",
    headers: HTML,
    signedIn: true,
    status: 200,
    kind: "page",
  },
  {
    name: "the address form",
    path: "/save",
    headers: HTML,
    signedIn: true,
    status: 200,
    kind: "page",
  },
  {
    name: "the save form",
    path: "/save?url=https%3A%2F%2Fexample.com%2Farticle",
    headers: HTML,
    signedIn: true,
    status: 200,
    kind: "page",
  },
  {
    name: "a save",
    method: "POST",
    path: "/save",
    headers: HTML,
    body: saveForm,
    signedIn: true,
    status: 200,
    kind: "page",
  },
  {
    name: "the address form's submission",
    method: "POST",
    path: "/save/address",
    headers: HTML,
    body: ownAddress,
    signedIn: true,
    status: 303,
    kind: "redirect",
  },
  {
    name: "the address form script's save link",
    method: "POST",
    path: "/save/address",
    headers: JSON_ACCEPT,
    body: ownAddress,
    signedIn: true,
    status: 200,
    kind: "body",
  },
  {
    name: "the address form script's rejected address",
    method: "POST",
    path: "/save/address",
    headers: JSON_ACCEPT,
    body: { url: "" },
    signedIn: true,
    status: 400,
    kind: "body",
  },
  {
    name: "a delete of a link that is not saved",
    method: "POST",
    path: "/bookmarks/1/delete",
    headers: HTML,
    body: { confirm: "yes" },
    signedIn: true,
    status: 404,
    kind: "page",
  },
  {
    name: "an unknown page",
    path: "/unknown",
    headers: HTML,
    signedIn: true,
    status: 404,
    kind: "page",
  },
];

function send(testCase: Case): Promise<Response> {
  const headers: Record<string, string> = { ...testCase.headers };
  if (testCase.method === "POST") {
    headers.origin = testCase.crossOrigin === true ? "https://evil.example" : origin;
  }
  if (testCase.signedIn) {
    headers.cookie = owner.cookie;
  }
  return server.fetch(testCase.path, {
    method: testCase.method ?? "GET",
    headers,
    body:
      testCase.body === undefined
        ? undefined
        : new URLSearchParams(
            typeof testCase.body === "function" ? testCase.body() : testCase.body,
          ),
    redirect: "manual",
  });
}

describe("every answer has the security headers for its kind", () => {
  it.each(cases)("$name", async (testCase) => {
    const response = await send(testCase);
    expect(response.status).toBe(testCase.status);
    expectHeadersFor(response, testCase.kind);
  });

  // A route that throws gets the entry point's 500, not the runtime's error page. The sessions
  // table is renamed away for this one request, so the session lookup fails inside D1, as it would
  // if D1 were unavailable, and no source has to change for the test.
  it("the 500 for a route that throws, which logs only the error's code", async () => {
    const DB = await db();
    server.clearLogs();
    await DB.prepare("ALTER TABLE sessions RENAME TO sessions_unavailable").run();
    let response: Response;
    try {
      response = await send({
        name: "",
        path: "/",
        headers: HTML,
        signedIn: true,
        status: 500,
        kind: "body",
      });
    } finally {
      await DB.prepare("ALTER TABLE sessions_unavailable RENAME TO sessions").run();
    }
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectHeadersFor(response, "body");
    const failures = server.getLogs().filter((log) => log.message.startsWith("Request failed:"));
    expect(failures.map((log) => log.message)).toEqual([
      expect.stringMatching(/^Request failed: [\w.-]+$/),
    ]);
    // The error's message is Drizzle's "Failed query: …", with the query and its parameters, and
    // its cause is D1's. Neither is logged, and nothing from the request is.
    const everything = JSON.stringify(server.getLogs());
    expect(everything).not.toContain("Failed query");
    expect(everything).not.toContain("no such table");
    expect(everything).not.toContain(owner.cookie.split("=")[1] ?? "");
  });

  // The session is extended on this answer, so the router copies it to add the cookie, before
  // the entry point adds the headers.
  it("a page whose answer extends the session", async () => {
    const DB = await db();
    await DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() + 60_000)
      .run();
    const response = await send({
      name: "",
      path: "/",
      headers: HTML,
      signedIn: true,
      status: 200,
      kind: "page",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expectHeadersFor(response, "page");
  });

  // The stylesheets and fonts are static assets on this origin (plan, "Design"), and nothing
  // broader is allowed, such as 'unsafe-inline' or another host.
  it("allows a page styles and fonts from this origin only", async () => {
    const response = await server.fetch("/auth/signed-out");
    const policy = new Map(
      (response.headers.get("content-security-policy") ?? "").split(";").map((directive) => {
        const [name = "", ...sources] = directive.trim().split(/\s+/);
        return [name, sources.join(" ")];
      }),
    );
    expect(policy.get("style-src")).toBe("'self'");
    expect(policy.get("font-src")).toBe("'self'");
    expect(policy.get("default-src")).toBe("'none'");
  });
});

describe("withSecurityHeaders", () => {
  it("replaces a weaker header that a route set", () => {
    const response = withSecurityHeaders(
      new Response("<p>x</p>", {
        headers: { "content-type": "text/html", "cache-control": "public, max-age=600" },
      }),
    );
    expectHeadersFor(response, "page");
  });

  it("adds the headers to a response whose own headers are immutable", () => {
    const response = withSecurityHeaders(Response.redirect("https://example.com/", 302));
    expect(response.headers.get("location")).toBe("https://example.com/");
    expectHeadersFor(response, "redirect");
  });

  it("reads the media type whatever its case and parameters", () => {
    expectHeadersFor(
      withSecurityHeaders(
        new Response("", { headers: { "content-type": "Text/HTML ; charset=utf-8" } }),
      ),
      "page",
    );
    expectHeadersFor(
      withSecurityHeaders(new Response("", { headers: { "content-type": "text/plain" } })),
      "body",
    );
  });
});
