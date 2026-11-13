import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  accountNotAllowedPage,
  notFoundPage,
  signedOutPage,
  signInFailedPage,
  signInLinkExpiredPage,
} from "../src/pages.ts";
import { privacyPage, RENEWAL_DAYS, SESSION_DAYS } from "../src/privacy-page.ts";
import { SESSION_LIFETIME_MS, shouldExtendSession } from "../src/auth/session-token.ts";
import { expectValidHtml } from "./validate-html.ts";
import { createTestWorker } from "./test-worker.ts";

describe.each([
  ["sign-in link expired", signInLinkExpiredPage, 400, false],
  ["sign-in failed", signInFailedPage, 400, false],
  ["account not allowed", accountNotAllowedPage, 403, false],
  ["signed out", signedOutPage, 200, false],
  ["privacy policy", privacyPage, 200, false],
  ["signed-out not found", () => notFoundPage(false), 404, false],
  ["signed-in not found", () => notFoundPage(true), 404, true],
])("the %s page", (_, render, status, signedIn) => {
  // The Worker's entry point adds the security headers to every answer, and
  // security-headers.test.ts checks them on each kind.
  it("has the status and the HTML content type", () => {
    const response = render();
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("links the tokens, then the stylesheet, and has no inline styles", async () => {
    const markup = await render().text();
    const stylesheets = [...markup.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)];
    expect(stylesheets.map((match) => match[1])).toEqual([
      "/assets/tokens.css",
      "/assets/site.css",
    ]);
    expect(markup).not.toMatch(/<style|style=/);
  });

  it(`shows ${signedIn ? "the navigation and Sign out" : "only the wordmark"} in the header`, async () => {
    const markup = await render().text();
    expect(markup).toContain('<a class="wordmark" href="/">');
    expect(markup.includes('<nav class="site-nav" aria-label="Main">')).toBe(signedIn);
    expect(markup.includes('<form method="post" action="/auth/sign-out">')).toBe(signedIn);
  });

  it("passes html-validate", async () => {
    await expectValidHtml(await render().text());
  });
});

describe("routes serve the pages", () => {
  const server = createTestWorker();
  let origin: string;

  beforeAll(async () => {
    origin = (await server.listen()).url.origin;
  });

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ["/auth/signed-out", 200, "You are signed out of Haystack"],
    ["/auth/unknown", 404, "Page not found"],
    ["/auth/callback?code=c&state=s", 400, "This sign-in link has expired"],
  ])("GET %s", async (path, status, heading) => {
    const response = await server.fetch(path);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain(`<h1>${heading}</h1>`);
  });

  // The Chrome Web Store listing links to the privacy policy, and its reviewers can't sign in,
  // so the page needs no session (#116).
  it("serves the privacy policy without a session", async () => {
    const response = await server.fetch("/privacy", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("<h1>Privacy policy</h1>");
  });

  it("answers HEAD /privacy without a session", async () => {
    const response = await server.fetch("/privacy", {
      method: "HEAD",
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  // Only GET and HEAD reach the page. A same-origin form submission without a session goes to
  // sign-in, as on any other path.
  it("doesn't serve the privacy policy to a POST", async () => {
    const response = await server.fetch("/privacy", {
      method: "POST",
      headers: { accept: "text/html", origin },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
  });
});

describe("the privacy policy's sign-in wording", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("states the session's lifetime and the part of it in which use renews it", async () => {
    expect(SESSION_DAYS * DAY_MS).toBe(SESSION_LIFETIME_MS);
    const expiresAt = SESSION_LIFETIME_MS;
    // Used just inside the last RENEWAL_DAYS: renewed. Used just before them: not.
    expect(shouldExtendSession(expiresAt, expiresAt - RENEWAL_DAYS * DAY_MS + 1)).toBe(true);
    expect(shouldExtendSession(expiresAt, expiresAt - RENEWAL_DAYS * DAY_MS - 1)).toBe(false);
    const markup = await privacyPage().text();
    expect(markup).toMatch(new RegExp(`signed in for ${SESSION_DAYS}\\s+days`));
    expect(markup).toMatch(new RegExp(`last ${RENEWAL_DAYS} of those days`));
  });
});
