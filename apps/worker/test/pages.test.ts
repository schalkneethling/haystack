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

const EXPECTED_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function expectHtmlHeaders(response: Response) {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

describe.each([
  ["sign-in link expired", signInLinkExpiredPage, 400],
  ["sign-in failed", signInFailedPage, 400],
  ["account not allowed", accountNotAllowedPage, 403],
  ["signed out", signedOutPage, 200],
  ["not found", notFoundPage, 404],
])("the %s page", (_, render, status) => {
  it("has the status and the security headers", () => {
    const response = render();
    expect(response.status).toBe(status);
    expectHtmlHeaders(response);
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
    expectHtmlHeaders(response);
    expect(await response.text()).toContain(`<h1>${heading}</h1>`);
  });
});
