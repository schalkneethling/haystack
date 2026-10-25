import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import {
  accountNotAllowedPage,
  notFoundPage,
  signedOutPage,
  signInFailedPage,
  signInLinkExpiredPage,
} from "../src/pages.ts";
import { expectValidHtml } from "./validate-html.ts";

describe.each([
  ["sign-in link expired", signInLinkExpiredPage, 400, false],
  ["sign-in failed", signInFailedPage, 400, false],
  ["account not allowed", accountNotAllowedPage, 403, false],
  ["signed out", signedOutPage, 200, false],
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
  const server = createTestHarness({
    workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
  });

  beforeAll(async () => {
    await server.listen();
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
});
