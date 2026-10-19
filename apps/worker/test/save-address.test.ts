// POST /save/address (#105): the address form's Continue screens the address, looks the page up,
// and redirects to the save form with what the page says about itself, or with the address alone.
// Every page comes from a local https fixture (page-fixture.ts), which also shows what the page's
// server saw. See "Save flow" in plans/haystack-v1-implementation-plan.md.
import type { ServerResponse } from "node:http";
import { createServer } from "node:net";
import { normalizeUrl, SAVE_URL_BUDGET } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { LOOKUP_TIMEOUT_MS } from "../src/page-lookup.ts";
import { type PageFixture, startPageFixture } from "./page-fixture.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

let fixture: PageFixture;
let server: ReturnType<typeof createTestHarness>;
let origin: string;

beforeAll(async () => {
  fixture = await startPageFixture();
  server = createTestHarness({
    workers: [
      {
        configPath: new URL("../wrangler.jsonc", import.meta.url),
        vars: { ALLOWED_EMAILS: "owner@example.com" },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
  await fixture.close();
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
  fixture.reset();
  server.clearLogs();
});

function postAddress(
  url: string | null,
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries({ origin, cookie: owner.cookie, ...headers })) {
    if (value !== null) {
      sent[name] = value;
    }
  }
  return server.fetch("/save/address", {
    method: "POST",
    headers: sent,
    body: new URLSearchParams(url === null ? {} : { url }),
    redirect: "manual",
  });
}

/** The fields of the save link a 303 sends the browser to. */
function savedLinkFields(response: Response): Record<string, string> {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${origin}/save`);
  return Object.fromEntries(location.searchParams);
}

function lookupLogs(): string[] {
  return server
    .getLogs()
    .map((log) => log.message)
    .filter((message) => message.startsWith("Page lookup"));
}

const FULL_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Document title</title>
    <meta name="description" content="Meta description">
    <meta property="og:title" content="Sharing title">
    <meta property="og:description" content="Sharing description">
    <meta property="og:site_name" content="Example">
    <link rel="canonical" href="/canonical">
  </head>
  <body><p>Body text</p></body>
</html>`;

describe("a page that says what it is", () => {
  it("redirects (303) to the save form with every field the extension captures", async () => {
    fixture.page("/full", FULL_PAGE);
    const response = await postAddress(fixture.url("/full"));
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/full"),
      canonical_url: fixture.url("/canonical"),
      title: "Document title",
      description: "Meta description",
      og_title: "Sharing title",
      og_description: "Sharing description",
      og_site_name: "Example",
    });
    expect(fixture.requests.map((request) => request.path)).toEqual(["/full"]);

    // The save form for that link is prefilled from the page, as for an extension link.
    const form = await server.fetch(response.headers.get("location") ?? "", {
      headers: { cookie: owner.cookie, accept: "text/html" },
    });
    expect(form.status).toBe(200);
    const markup = await form.text();
    expect(markup).toMatch(/<input\s+id="confirmed-title"[^>]*value="Sharing title"/);
    expect(markup).toContain(">Sharing description</textarea>");
    // Showing the form fetched nothing.
    expect(fixture.requests).toHaveLength(1);
  });

  it("reads the page as a browser does: decoded, case-insensitive, first tag with content", async () => {
    fixture.page(
      "/docs/rules",
      `<HTML><HEAD>
        <BASE HREF="/docs/base/">
        <TITLE>
          Tom &amp; Jerry&mdash;the   &quot;show&quot; &#8211; &#x1F600;
        </TITLE>
        <META NAME="Description" CONTENT="Caf&eacute; &amp; bar">
        <meta property="og:title" content="   ">
        <meta name="OG:Title" content="From the name attribute">
        <meta property="og:title" content="A later one">
        <link rel="stylesheet canonical" href="">
        <link rel="Canonical" href="page?x=1&amp;y=2">
      </HEAD><BODY></BODY></HTML>`,
    );
    expect(savedLinkFields(await postAddress(fixture.url("/docs/rules")))).toEqual({
      url: fixture.url("/docs/rules"),
      // A blank href is skipped, and the next one resolves against the base element's href.
      canonical_url: fixture.url("/docs/base/page?x=1&y=2"),
      title: 'Tom & Jerry—the "show" – 😀',
      description: "Café & bar",
      og_title: "From the name attribute",
    });
  });

  it("cuts long values to their caps, as the extension does", async () => {
    fixture.page(
      "/long",
      `<head><title>${"t".repeat(250)}</title><meta name="description" content="${"d".repeat(350)}"></head>`,
    );
    const fields = savedLinkFields(await postAddress(fixture.url("/long")));
    expect(fields.title).toBe("t".repeat(200));
    expect(fields.description).toBe("d".repeat(300));
  });

  it("fetches the page without tracking parameters, and sends the address as typed", async () => {
    fixture.page("/tracked?id=7", FULL_PAGE);
    const url = fixture.url("/tracked?utm_source=newsletter&id=7");
    const fields = savedLinkFields(await postAddress(` ${url} `));
    expect(fixture.requests.map((request) => request.path)).toEqual(["/tracked?id=7"]);
    // GET /save strips the tracking parameters before it shows and stores the address.
    expect(fields.url).toBe(url);
    expect(fields.title).toBe("Document title");
  });

  it("names Haystack and its address, and sends no cookie or credential", async () => {
    fixture.page("/headers", FULL_PAGE);
    await postAddress(fixture.url("/headers"), { authorization: "Bearer from-the-browser" });
    const [request] = fixture.requests;
    expect(request?.headers["user-agent"]).toBe(`Haystack (+${origin})`);
    expect(request?.headers.accept).toBe("text/html");
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(request?.headers)).not.toContain(owner.cookie.split("=")[1]);
  });

  it("drops a canonical URL that carries a secret, as GET /save does, and keeps the rest", async () => {
    fixture.page(
      "/share",
      `<head><title>Shared page</title>
        <link rel="canonical" href="https://docs.example/d/1?access_token=secret-value"></head>`,
    );
    const response = await postAddress(fixture.url("/share"));
    expect(savedLinkFields(response)).toEqual({ url: fixture.url("/share"), title: "Shared page" });
    expect(response.headers.get("location")).not.toContain("secret-value");
  });

  it("keeps the save link within the budget, dropping optional fields in the extension's order", async () => {
    // Characters that encode to 9 each, at every cap, so the link is far over the budget.
    const wide = (length: number) => "標".repeat(length);
    fixture.page(
      "/budget",
      `<head><title>${wide(200)}</title>
        <meta name="description" content="${wide(300)}">
        <meta property="og:title" content="${wide(200)}">
        <meta property="og:description" content="${wide(300)}">
        <meta property="og:site_name" content="${wide(100)}">
        <link rel="canonical" href="/budget-canonical"></head>`,
    );
    const response = await postAddress(fixture.url("/budget"));
    const location = response.headers.get("location") ?? "";
    expect(location.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
    // Dropping og_description, the first field of the order, is enough.
    expect(Object.keys(savedLinkFields(response)).sort()).toEqual(
      ["canonical_url", "description", "og_site_name", "og_title", "title", "url"].sort(),
    );
  });
});

describe("the read stops early", () => {
  // A response that never ends: the prefix, then the filler again and again until the test stops
  // it. `fast` sends the filler as fast as the connection takes it. Otherwise one small piece of
  // it goes every 50 ms, so reading to the byte limit would take far longer than the time limit.
  let open: ServerResponse[] = [];
  function endless(path: string, prefix: string, filler: string, fast: boolean): void {
    fixture.route(path, (_, response) => {
      open.push(response);
      response.writeHead(200, { "content-type": "text/html" });
      response.write(prefix);
      if (!fast) {
        const timer = setInterval(() => response.write(filler), 50);
        response.on("close", () => clearInterval(timer));
        return;
      }
      const chunk = Buffer.from(filler.repeat(Math.ceil(16_384 / filler.length)));
      const pump = () => {
        while (!response.destroyed) {
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
  }

  beforeEach(() => {
    open = [];
  });

  function stopAll(): void {
    for (const response of open) {
      response.destroy();
    }
  }

  // A Worker that read the whole page would never answer, or would answer at the time limit with
  // the address alone. Getting the title back well before the time limit means that the read
  // stopped where the test says, because the page trickles on after that point. The tag after
  // that point, which a read that went on would find, shows that nothing after it is taken.
  it("at </head>", async () => {
    endless(
      "/endless-body",
      `<head><title>Endless body</title></head><meta property="og:description" content="after the head">`,
      "<p>more body text</p>",
      false,
    );
    const started = performance.now();
    const response = await postAddress(fixture.url("/endless-body"));
    stopAll();
    expect(performance.now() - started).toBeLessThan(LOOKUP_TIMEOUT_MS / 2);
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/endless-body"),
      title: "Endless body",
    });
  });

  it("at <body>, when the page has no </head>", async () => {
    endless(
      "/no-head-end",
      '<title>No head end</title><meta name="description" content="Before the body"><body><meta property="og:description" content="in the body">',
      "<p>more body text</p>",
      false,
    );
    const started = performance.now();
    const response = await postAddress(fixture.url("/no-head-end"));
    stopAll();
    expect(performance.now() - started).toBeLessThan(LOOKUP_TIMEOUT_MS / 2);
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/no-head-end"),
      title: "No head end",
      description: "Before the body",
    });
  });

  // The head never ends, and it arrives as fast as the Worker reads it, so only the byte limit
  // can stop the read before the time limit.
  it("at the byte limit, when the head never ends", async () => {
    endless(
      "/endless-head",
      "<head><title>Endless head</title>",
      '<meta name="filler" content="a value that goes on">',
      true,
    );
    const started = performance.now();
    const response = await postAddress(fixture.url("/endless-head"));
    stopAll();
    expect(performance.now() - started).toBeLessThan(LOOKUP_TIMEOUT_MS);
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/endless-head"),
      title: "Endless head",
    });
  });
});

// A port on this machine that nothing listens on.
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") {
    throw new Error("The probe has no port");
  }
  return address.port;
}

describe("a lookup that gives nothing redirects with the address alone", () => {
  // Each fallback logs a fixed code, and never the address or anything from the page.
  function expectAddressAlone(response: Response, url: string, code?: string): void {
    expect(savedLinkFields(response)).toEqual({ url });
    const logs = lookupLogs();
    if (code !== undefined) {
      expect(logs).toEqual([`Page lookup gave no metadata: ${code}`]);
    }
    const everything = JSON.stringify(server.getLogs());
    expect(everything).not.toContain("127.0.0.1");
    expect(everything).not.toContain("page-marker");
  }

  it("when the page does not answer within the time limit", async () => {
    fixture.route("/slow?page-marker", () => {
      // Never answers. Closing the fixture ends the connection.
    });
    const started = performance.now();
    const response = await postAddress(fixture.url("/slow?page-marker"));
    const elapsed = performance.now() - started;
    expectAddressAlone(response, fixture.url("/slow?page-marker"), "timeout");
    expect(elapsed).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(LOOKUP_TIMEOUT_MS + 2000);
  });

  it("when the page stops sending before its head ends", async () => {
    fixture.route("/stalls", (_, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><head><title>page-marker</title>");
    });
    const started = performance.now();
    const response = await postAddress(fixture.url("/stalls"));
    expectAddressAlone(response, fixture.url("/stalls"), "timeout");
    expect(performance.now() - started).toBeLessThan(LOOKUP_TIMEOUT_MS + 2000);
  });

  // In the test harness, Node makes the request (page-fixture.ts), and a request it cannot make
  // reaches the Worker as a 500 response rather than an error, so the logged code is not checked.
  it("when the page cannot be reached", async () => {
    const url = `https://127.0.0.1:${await closedPort()}/page-marker`;
    expectAddressAlone(await postAddress(url), url);
    expect(lookupLogs()).toHaveLength(1);
  });

  it.each([404, 410, 500, 503])("when the page answers %i", async (status) => {
    fixture.route("/status", (_, response) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end("<head><title>page-marker</title></head>");
    });
    expectAddressAlone(await postAddress(fixture.url("/status")), fixture.url("/status"), "status");
  });

  it.each([
    ["JSON", "application/json"],
    ["plain text", "text/plain"],
    ["XHTML", "application/xhtml+xml"],
    ["no content type", null],
  ])("when the page is %s", async (_, contentType) => {
    fixture.route("/other", (__, response) => {
      response.writeHead(200, contentType === null ? {} : { "content-type": contentType });
      response.end("<head><title>page-marker</title></head>");
    });
    expectAddressAlone(await postAddress(fixture.url("/other")), fixture.url("/other"), "not-html");
  });

  it.each([
    ["no metadata", "<html><head></head><body>page-marker</body></html>"],
    ["only blank values", '<head><title>  </title><meta name="description" content=" "></head>'],
  ])("when the page has %s", async (_, page) => {
    fixture.page("/bare", page);
    expectAddressAlone(
      await postAddress(fixture.url("/bare")),
      fixture.url("/bare"),
      "no-metadata",
    );
  });

  it.each([
    ["a canonical URL over its cap", `/${"a".repeat(2048)}`],
    ["a canonical URL that is not an http(s) link", "javascript:alert('page-marker')"],
  ])("when the page has %s", async (_, href) => {
    fixture.page(
      "/invalid",
      `<head><title>page-marker</title><link rel="canonical" href="${href}"></head>`,
    );
    expectAddressAlone(
      await postAddress(fixture.url("/invalid")),
      fixture.url("/invalid"),
      "invalid",
    );
  });

  it("when the address is already saved, without looking it up", async () => {
    const url = fixture.url("/saved");
    fixture.page("/saved", FULL_PAGE);
    await seedBookmark(await db(), owner.userId, url, normalizeUrl(url));
    expect(savedLinkFields(await postAddress(url))).toEqual({ url });
    expect(fixture.requests).toHaveLength(0);
  });
});

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";

describe("an address the checks reject", () => {
  it.each([
    ["an http: address", "http://127.0.0.1/page", ADDRESS_RULE],
    ["an address without a scheme", "127.0.0.1/page", ADDRESS_RULE],
    ["an empty address", "", "Enter the address of a page, starting with https://."],
    ["no address at all", null, "Enter the address of a page, starting with https://."],
  ])(
    "gets the address form with its error (400) for %s, and nothing is fetched",
    async (_, url, error) => {
      const response = await postAddress(url);
      expect(response.status).toBe(400);
      const markup = await response.text();
      expect(markup).toContain(`<p id="save-url-error">${error}</p>`);
      expect(markup).toMatch(/<input id="save-url"[^>]* aria-invalid="true"/);
      expect(fixture.requests).toHaveLength(0);
      await expectValidHtml(markup);
    },
  );

  it("does not echo a flagged address, and fetches nothing", async () => {
    fixture.page("/cb", FULL_PAGE);
    const response = await postAddress(fixture.url("/cb?access_token=secret-value"));
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("This link contains an access token, key, or password");
    expect(markup).not.toContain("secret-value");
    expect(fixture.requests).toHaveLength(0);
  });

  it("gets the same page as GET /save gives for that address", async () => {
    const url = "http://127.0.0.1/page";
    const posted = await (await postAddress(url)).text();
    const got = await (
      await server.fetch(`/save?${new URLSearchParams({ url }).toString()}`, {
        headers: { cookie: owner.cookie, accept: "text/html" },
      })
    ).text();
    expect(posted).toBe(got);
  });
});

describe("only a signed-in POST from Haystack looks a page up", () => {
  it.each([
    ["signed out", { cookie: null }, 401],
    ["from another origin", { origin: "https://evil.example" }, 403],
    ["without an Origin header", { origin: null }, 403],
  ])("refuses a POST %s, and fetches nothing", async (_, headers, status) => {
    fixture.page("/page", FULL_PAGE);
    const response = await postAddress(fixture.url("/page"), headers);
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  });

  it("never fetches on GET /save, whatever the link", async () => {
    fixture.page("/page", FULL_PAGE);
    const response = await server.fetch(
      `/save?${new URLSearchParams({ url: fixture.url("/page") }).toString()}`,
      {
        headers: { cookie: owner.cookie, accept: "text/html" },
      },
    );
    expect(response.status).toBe(200);
    expect(fixture.requests).toHaveLength(0);
  });

  it("is a POST route only", async () => {
    const response = await server.fetch(
      `/save/address?${new URLSearchParams({ url: fixture.url("/page") }).toString()}`,
      { headers: { cookie: owner.cookie, accept: "text/html" } },
    );
    expect(response.status).toBe(404);
    expect(fixture.requests).toHaveLength(0);
  });
});
