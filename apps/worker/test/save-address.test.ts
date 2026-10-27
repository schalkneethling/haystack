// POST /save/address (#105): the address form's Continue screens the address, looks the page up,
// and redirects to the save form with what the page says about itself, or with the address alone.
// Every page is answered by the page fixture (page-fixture.ts), which also shows what the page's
// server would see, and fails a test that makes a request it did not plan for. See "Save flow" in
// plans/haystack-v1-implementation-plan.md.
import { normalizeUrl, SAVE_URL_BUDGET } from "@haystack/schemas";
import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import {
  LOOKUP_ELEMENT_BUDGET,
  LOOKUP_READ_LIMIT_BYTES,
  LOOKUP_TIMEOUT_MS,
} from "../src/page-lookup.ts";
import { type PageFixture, startPageFixture } from "./page-fixture.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

let fixture: PageFixture;
let server: ReturnType<typeof createTestHarness>;
let origin: string;

beforeAll(async () => {
  fixture = startPageFixture();
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
  fixture.close();
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

// A request that no test planned for would otherwise only make the Worker fall back.
afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
});

function postAddress(
  url: string | null,
  headers: Record<string, string | null> = {},
  target = "/save/address",
): Promise<Response> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries({ origin, cookie: owner.cookie, ...headers })) {
    if (value !== null) {
      sent[name] = value;
    }
  }
  return server.fetch(target, {
    method: "POST",
    headers: sent,
    body: new URLSearchParams(url === null ? {} : { url }),
    redirect: "manual",
  });
}

/** The fields of the save link a 303 sends the browser to. */
function savedLinkFields(response: Response, worker = origin): Record<string, string> {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${worker}/save`);
  return Object.fromEntries(location.searchParams);
}

function lookupLogs(): string[] {
  return server
    .getLogs()
    .map((log) => log.message)
    .filter((message) => message.startsWith("Page lookup"));
}

const encoder = new TextEncoder();

function html(
  body: ConstructorParameters<typeof Response>[0],
  headers: Record<string, string> = {},
): Response {
  return new HttpResponse(body, { headers: { "content-type": "text/html", ...headers } });
}

/** Resolves after `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Endless {
  readonly body: ReadableStream<Uint8Array>;
  /** Ends the body. The Worker's cancel does not reach this side (page-fixture.ts says why). */
  stop(): void;
}

/**
 * A body that never ends on its own: `first`, then `filler` again and again until `stop`. With
 * `everyMs`, one piece of filler goes every `everyMs`, so reading on to the byte limit would take
 * far longer than the time limit. Without it, the filler goes as fast as it is read, in 16 KiB
 * pieces. With `everyMs: Infinity`, nothing follows `first`: the page stalls.
 */
function endless(first: string, filler: string, everyMs?: number): Endless {
  let stopped = false;
  let wake: () => void = () => {};
  const piece = encoder.encode(
    everyMs === undefined ? filler.repeat(Math.ceil(16_384 / filler.length)) : filler,
  );
  let sentFirst = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(encoder.encode(first));
        return;
      }
      if (everyMs === Infinity) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      } else {
        // Yields to the event loop even when there is no wait, so a fast body cannot starve it.
        await sleep(everyMs ?? 0);
      }
      if (stopped) {
        controller.close();
        return;
      }
      controller.enqueue(piece);
    },
  });
  return {
    body,
    stop: () => {
      stopped = true;
      wake();
    },
  };
}

// A page that never answers.
const NEVER: Promise<Response> = new Promise(() => {});

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

  it("keeps a canonical link to another host", async () => {
    fixture.page(
      "/syndicated",
      `<head><title>Syndicated</title><link rel="canonical" href="https://www.other.test/original"></head>`,
    );
    expect(savedLinkFields(await postAddress(fixture.url("/syndicated")))).toEqual({
      url: fixture.url("/syndicated"),
      canonical_url: "https://www.other.test/original",
      title: "Syndicated",
    });
    // The canonical link is evidence, not a page to fetch.
    expect(fixture.requests.map((request) => request.url)).toEqual([fixture.url("/syndicated")]);
  });

  it("reads a page in the charset its content type names", async () => {
    fixture.route("/latin-1", () =>
      html(
        new Uint8Array([
          ...encoder.encode("<head><title>Caf"),
          0xe9,
          ...encoder.encode("</title></head>"),
        ]),
        {
          "content-type": "text/html; charset=windows-1252",
        },
      ),
    );
    expect(savedLinkFields(await postAddress(fixture.url("/latin-1")))).toEqual({
      url: fixture.url("/latin-1"),
      title: "Café",
    });
  });

  // An empty label declares nothing, and a browser ignores it. The header names no charset, so the
  // page's own declaration is the one that counts.
  it.each([
    ["empty", '<meta charset="">'],
    ["only whitespace", '<meta charset="  ">'],
    [
      "empty, in <meta http-equiv>",
      '<meta http-equiv="content-type" content="text/html; charset=">',
    ],
  ])("ignores a charset label that is %s", async (_, declaration) => {
    fixture.route("/no-label", () => html(`<head>${declaration}<title>No label</title></head>`));
    expect(savedLinkFields(await postAddress(fixture.url("/no-label")))).toEqual({
      url: fixture.url("/no-label"),
      title: "No label",
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
    expect(request?.headers.get("user-agent")).toBe(`Haystack (+${origin})`);
    expect(request?.headers.get("accept")).toBe("text/html");
    expect(request?.headers.get("cookie")).toBeNull();
    expect(request?.headers.get("authorization")).toBeNull();
    const session = owner.cookie.split("=")[1] ?? "";
    expect(JSON.stringify([...(request?.headers.entries() ?? [])])).not.toContain(session);
  });

  it("drops a canonical URL that carries a secret, as GET /save does, and keeps the rest", async () => {
    fixture.page(
      "/share",
      `<head><title>Shared page</title>
        <link rel="canonical" href="https://docs.test/d/1?access_token=secret-value"></head>`,
    );
    const response = await postAddress(fixture.url("/share"));
    // The link says that a canonical URL was dropped (#131), and carries nothing of it.
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/share"),
      title: "Shared page",
      sensitive_canonical_dropped: "1",
    });
    expect(response.headers.get("location")).not.toContain("secret-value");
  });

  // The three ways a flagged canonical URL is dropped each end with the flag stored (#131). The
  // address form's lookup builds the link here, and the form it opens passes the flag on. The
  // popup's link and a hand-built one are tested in save-post.test.ts and save-form.test.ts.
  it("stores the flag when the form from the lookup's link is saved", async () => {
    fixture.page(
      "/stored",
      `<head><title>Shared page</title>
        <link rel="canonical" href="https://docs.test/d/1?access_token=secret-value"></head>`,
    );
    const link = (await postAddress(fixture.url("/stored"))).headers.get("location") ?? "";
    const form = await (
      await server.fetch(link, { headers: { cookie: owner.cookie, accept: "text/html" } })
    ).text();
    const hidden = Object.fromEntries(
      [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [
        match[1] ?? "",
        match[2] ?? "",
      ]),
    );
    expect(hidden).toMatchObject({ sensitive_canonical_dropped: "1" });

    const saved = await server.fetch("/save", {
      method: "POST",
      headers: { origin, cookie: owner.cookie },
      body: new URLSearchParams({ ...hidden, confirmed_title: "Shared page" }),
    });
    expect(saved.status).toBe(200);
    const { results } = await (
      await db()
    )
      .prepare("SELECT canonical_url, sensitive_canonical_dropped FROM bookmarks")
      .all();
    expect(results).toEqual([{ canonical_url: null, sensitive_canonical_dropped: 1 }]);
  });

  it("says a canonical URL was dropped when it is the only thing the page gives", async () => {
    fixture.page(
      "/bare-share",
      `<head><link rel="canonical" href="https://docs.test/d/1?access_token=secret-value"></head>`,
    );
    const response = await postAddress(fixture.url("/bare-share"));
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/bare-share"),
      sensitive_canonical_dropped: "1",
    });
  });

  it("keeps the flag when the budget drops optional fields", async () => {
    const wide = (length: number) => "標".repeat(length);
    fixture.page(
      "/budget-share",
      `<head><title>${wide(200)}</title>
        <meta name="description" content="${wide(300)}">
        <meta property="og:title" content="${wide(200)}">
        <meta property="og:description" content="${wide(300)}">
        <meta property="og:site_name" content="${wide(100)}">
        <link rel="canonical" href="https://docs.test/d/1?access_token=secret-value"></head>`,
    );
    const response = await postAddress(fixture.url("/budget-share"));
    expect(response.headers.get("location")?.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
    expect(savedLinkFields(response).sensitive_canonical_dropped).toBe("1");
  });

  it("does not say a canonical URL was dropped when the page's is kept or absent", async () => {
    fixture.page("/kept", FULL_PAGE);
    fixture.page("/no-canonical", "<head><title>No canonical</title></head>");
    for (const path of ["/kept", "/no-canonical"]) {
      const response = await postAddress(fixture.url(path));
      expect(savedLinkFields(response)).not.toHaveProperty("sensitive_canonical_dropped");
    }
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
  // The page trickles on after the point where the read should stop, so a Worker that read on
  // would never answer, or would answer at the time limit with the address alone. Getting the
  // title back therefore shows that the read stopped there. The tests don't time the lookup,
  // because a bound on the time would add nothing to that, and could fail on a busy machine
  // although the lookup is right (#141). The tag after that point, which a read that went on
  // would find, shows that nothing after it is taken.
  it("at </head>", async () => {
    const page = endless(
      `<head><title>Endless body</title></head><meta property="og:description" content="after the head">`,
      "<p>more body text</p>",
      50,
    );
    fixture.route("/endless-body", () => html(page.body));
    const response = await postAddress(fixture.url("/endless-body"));
    page.stop();
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/endless-body"),
      title: "Endless body",
    });
  });

  it("at <body>, when the page has no </head>", async () => {
    const page = endless(
      '<title>No head end</title><meta name="description" content="Before the body"><body><meta property="og:description" content="in the body">',
      "<p>more body text</p>",
      50,
    );
    fixture.route("/no-head-end", () => html(page.body));
    const response = await postAddress(fixture.url("/no-head-end"));
    page.stop();
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/no-head-end"),
      title: "No head end",
      description: "Before the body",
    });
  });

  // The head never ends, and it arrives as fast as the Worker reads it, so only the byte limit
  // can stop the read before the time limit. The filler is a comment, so that the element budget
  // below is not what stops it. As above, the title shows that the read stopped before the time
  // limit, so the test doesn't time the lookup (#141).
  it("at the byte limit, when the head never ends", async () => {
    const page = endless("<head><title>Endless head</title>", "<!-- a comment that goes on -->");
    fixture.route("/endless-head", () => html(page.body));
    const response = await postAddress(fixture.url("/endless-head"));
    page.stop();
    expect(savedLinkFields(response)).toEqual({
      url: fixture.url("/endless-head"),
      title: "Endless head",
    });
  });

  // Each tag the reader wants costs CPU time in JavaScript, so it takes LOOKUP_ELEMENT_BUDGET of
  // them at most. What it read before that is kept, and nothing after it is read.
  it("after the element budget, keeping what it read before", async () => {
    const repeated = Array.from(
      { length: LOOKUP_ELEMENT_BUDGET + 50 },
      (_, index) => `<meta property="og:site_name" content="Site ${index}">`,
    ).join("");
    fixture.page("/many-tags", `<head>${repeated}<title>After the budget</title></head>`);
    expect(savedLinkFields(await postAddress(fixture.url("/many-tags")))).toEqual({
      url: fixture.url("/many-tags"),
      og_site_name: "Site 0",
    });
  });

  it("not because of tags it does not want, which never count against the budget", async () => {
    const preloads = '<link rel="preload" href="/font.woff2" as="font">'.repeat(
      LOOKUP_ELEMENT_BUDGET * 2,
    );
    fixture.page("/many-preloads", `<head>${preloads}<title>After the preloads</title></head>`);
    expect(savedLinkFields(await postAddress(fixture.url("/many-preloads")))).toEqual({
      url: fixture.url("/many-preloads"),
      title: "After the preloads",
    });
  });

  // A page made of nothing but one tag that reaches a handler, up to the byte limit, is the most
  // work a page can ask of the reader along that path. Each such page is looked up no slower than
  // a page of the same size whose read ends at the first </head>, give or take a margin, because
  // every handler call counts against the budget, and the reader stops the rewriter outright once
  // it is done.
  it.each([
    ["<meta name=description>", '<meta name="description" content="x">'],
    ["<head>", "<head>"],
    ["<title>", "<title>x</title>"],
    // An empty title has no text to count, so only its element counts.
    ["an empty <title>", "<title></title>"],
    ["<body>", "<body>"],
  ])(
    "so a page full of %s is looked up as fast as a page of the same size whose read ends early",
    async (_, tag) => {
      const filled = tag.repeat(Math.ceil(LOOKUP_READ_LIMIT_BYTES / tag.length));
      const full = `<head>${filled}<title>T</title></head>`;
      // Within a few bytes of the full page's size, so the fixture sends about as many bytes after
      // the Worker has stopped reading, but the reader is done at the first </head>.
      const early = "<head><title>T</title></head>";
      fixture.page("/full-of-tags", full);
      fixture.page("/early", early + "<!---->".repeat(Math.ceil((full.length - early.length) / 7)));
      async function timed(path: string): Promise<number> {
        const started = performance.now();
        expect((await postAddress(fixture.url(path))).status).toBe(303);
        return performance.now() - started;
      }
      // The fastest of a few runs, so a moment of load on the machine does not count. The runs
      // alternate between the two pages, so a burst of load falls on both of them rather than on
      // whichever page was being timed at that moment (#161).
      const earlyTimes: number[] = [];
      const fullTimes: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        earlyTimes.push(await timed("/early"));
        fullTimes.push(await timed("/full-of-tags"));
      }
      // Measured against a tiny page with the fix: 0 to 2 ms slower on every path. Without it,
      // about 130 ms for <head> and 360 ms for <title>, and about 90 ms for the meta tag without
      // the budget. Against this page with only the element budget lifted, <head>, <title>, an
      // empty <title> and the meta tag were about 190, 530, 200 and 90 ms slower (#161). So 50 ms
      // tells them apart with room for load. <body> cost only about 10 ms without the fix, under
      // the margin, so this holds it to the margin but does not show its fix.
      expect(Math.min(...fullTimes) - Math.min(...earlyTimes)).toBeLessThan(50);
    },
  );
});

describe("a lookup that gives nothing redirects with the address alone", () => {
  // Each fallback logs a fixed code, and never the address or anything from the page.
  function expectAddressAlone(response: Response, url: string, code?: string): void {
    expect(savedLinkFields(response)).toEqual({ url });
    const logs = lookupLogs();
    if (code !== undefined) {
      expect(logs).toEqual([`Page lookup gave no metadata: ${code}`]);
    }
    const everything = JSON.stringify(server.getLogs());
    expect(everything).not.toContain("pages.test");
    expect(everything).not.toContain("page-marker");
  }

  // These two pages never finish, so a lookup that the time limit did not end would never answer,
  // and the test's own timeout fails it. That timeout is the bound: the time limit plus 2 seconds,
  // set on each test so that a change to Vitest's default can't widen it. A bound measured inside
  // the test would add nothing, and a tighter one would fail on a busy machine although the lookup
  // is right (#141). Both tests also show that the lookup waits for the whole time limit, so a page
  // that stalls isn't given up on early.
  it(
    "when the page does not answer within the time limit",
    { timeout: LOOKUP_TIMEOUT_MS + 2000 },
    async () => {
      fixture.route("/slow?page-marker", () => NEVER);
      const started = performance.now();
      const response = await postAddress(fixture.url("/slow?page-marker"));
      const elapsed = performance.now() - started;
      expectAddressAlone(response, fixture.url("/slow?page-marker"), "timeout");
      expect(elapsed).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS - 100);
    },
  );

  it(
    "when the page stops sending before its head ends",
    { timeout: LOOKUP_TIMEOUT_MS + 2000 },
    async () => {
      const page = endless("<html><head><title>page-marker</title>", "", Infinity);
      fixture.route("/stalls", () => html(page.body));
      const started = performance.now();
      const response = await postAddress(fixture.url("/stalls"));
      const elapsed = performance.now() - started;
      page.stop();
      expectAddressAlone(response, fixture.url("/stalls"), "timeout");
      expect(elapsed).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS - 100);
    },
  );

  // In the test harness, Node makes the request (page-fixture.ts), and a request it cannot make
  // reaches the Worker as a 500 response rather than an error, so the logged code is "status".
  it("when the page cannot be reached", async () => {
    fixture.route("/unreachable", () => HttpResponse.error());
    expectAddressAlone(await postAddress(fixture.url("/unreachable")), fixture.url("/unreachable"));
    expect(lookupLogs()).toHaveLength(1);
  });

  it.each([404, 410, 500, 503])("when the page answers %i", async (status) => {
    fixture.route(
      "/status",
      () =>
        new HttpResponse("<head><title>page-marker</title></head>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    );
    expectAddressAlone(await postAddress(fixture.url("/status")), fixture.url("/status"), "status");
  });

  it.each([
    ["JSON", "application/json"],
    ["plain text", "text/plain"],
    ["XHTML", "application/xhtml+xml"],
  ])("when the page is %s", async (_, contentType) => {
    fixture.route("/other", () =>
      html("<head><title>page-marker</title></head>", { "content-type": contentType }),
    );
    expectAddressAlone(await postAddress(fixture.url("/other")), fixture.url("/other"), "not-html");
  });

  it("when the page has no content type", async () => {
    fixture.route("/untyped", () => {
      const response = new HttpResponse("<head><title>page-marker</title></head>");
      response.headers.delete("content-type");
      return response;
    });
    expectAddressAlone(
      await postAddress(fixture.url("/untyped")),
      fixture.url("/untyped"),
      "not-html",
    );
  });

  it.each([
    ["no metadata", () => html("<html><head></head><body>page-marker</body></html>")],
    [
      "only blank values",
      () => html('<head><title>  </title><meta name="description" content=" "></head>'),
    ],
    ["an empty body", () => html("")],
    ["no body at all (204)", () => new HttpResponse(null, { status: 204 })],
  ])("when the page has %s", async (_, resolver) => {
    fixture.route("/bare", resolver);
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

  // The rewriter decodes by the header's charset alone, so a page that declares another one only
  // in its head would come out garbled ("Caf� au lait").
  it.each([
    ["<meta charset>", '<meta charset="windows-1252">'],
    [
      "<meta http-equiv>",
      '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">',
    ],
  ])("when the page declares a charset other than UTF-8 in %s only", async (_, declaration) => {
    fixture.route("/legacy", () =>
      html(
        new Uint8Array([
          ...encoder.encode(`<head>${declaration}<title>Caf`),
          0xe9,
          ...encoder.encode(" au lait page-marker</title></head>"),
        ]),
      ),
    );
    expectAddressAlone(
      await postAddress(fixture.url("/legacy")),
      fixture.url("/legacy"),
      "charset",
    );
  });

  it("when the address is already saved, whatever its host's case, without looking it up", async () => {
    fixture.page("/Saved", FULL_PAGE);
    await seedBookmark(
      await db(),
      owner.userId,
      fixture.url("/Saved"),
      normalizeUrl(fixture.url("/Saved")),
    );
    const typed = "https://PAGES.Test/Saved";
    expect(savedLinkFields(await postAddress(typed))).toEqual({ url: typed });
    expect(fixture.requests).toHaveLength(0);
  });

  // The harness accepts an absolute address and gives the Worker its host, so the Worker runs at
  // haystack.test here (the harness hands the request over as http, which is why the Worker
  // compares hosts). A Haystack address is never fetched, and the fixture would show it if it were.
  it("when the address is one of Haystack's own, without looking it up", async () => {
    const haystack = "https://haystack.test";
    fixture.page(`${haystack}/saved-links?page-marker`, FULL_PAGE);
    const response = await postAddress(
      `${haystack}/saved-links?page-marker`,
      { origin: haystack },
      `${haystack}/save/address`,
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/save");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      url: `${haystack}/saved-links?page-marker`,
    });
    expect(fixture.requests).toHaveLength(0);
    expect(lookupLogs()).toEqual([]);
  });
});

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";

describe("an address the checks reject", () => {
  it.each([
    ["an http: address", "http://pages.test/page", ADDRESS_RULE],
    ["an address without a scheme", "pages.test/page", ADDRESS_RULE],
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
    const url = "http://pages.test/page";
    const posted = await (await postAddress(url)).text();
    const got = await (
      await server.fetch(`/save?${new URLSearchParams({ url }).toString()}`, {
        headers: { cookie: owner.cookie, accept: "text/html" },
      })
    ).text();
    expect(posted).toBe(got);
  });
});

// Without JavaScript, the address form's submission asks for HTML. Without a session it gets the
// answer the form shown before sign-in gets for the address, which asks for GET /save (#34).
describe("the address form's submission without a session, without JavaScript", () => {
  const HTML = { accept: "text/html,application/xhtml+xml", cookie: null };

  it("is sent through sign-in to the save form for the address, and fetches nothing", async () => {
    fixture.page("/signed-out", FULL_PAGE);
    const url = fixture.url("/signed-out");
    const response = await postAddress(url, HTML);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "", origin);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("return_to")).toBe(
      `/save?${new URLSearchParams({ url }).toString()}`,
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("gets the address form's error for a flagged address, with no redirect", async () => {
    const response = await postAddress("https://example.com/cb?access_token=secret-value", HTML);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const markup = await response.text();
    expect(markup).toContain("This link contains an access token, key, or password");
    expect(markup).not.toContain("secret-value");
    // The signed-out form asks for GET /save.
    expect(markup).toContain('method="get" action="/save"');
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("only a signed-in POST from Haystack looks a page up", () => {
  it.each([
    ["signed out", { cookie: null }, 401],
    ["from another origin", { origin: "https://evil.test" }, 403],
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

// The address form's script posts the same form to the same route with `fetch`, and asks for
// JSON (address-form.js). The route's checks are the same; only the answer's form differs.
describe("an answer in JSON, for the address form's script", () => {
  const JSON_ACCEPT = { accept: "application/json" };

  async function expectJsonAnswer(response: Response, status: number): Promise<unknown> {
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBeNull();
    // The security headers of a JSON answer are checked with every other answer's, in
    // security-headers.test.ts.
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    return response.json();
  }

  function fieldsOfLink(answer: unknown): Record<string, string> {
    const link = new URL((answer as { saveLink: string }).saveLink);
    expect(link.origin + link.pathname).toBe(`${origin}/save`);
    return Object.fromEntries(link.searchParams);
  }

  it("gives the save link with the page's fields, instead of redirecting to it", async () => {
    fixture.page("/json", FULL_PAGE);
    const answer = await expectJsonAnswer(
      await postAddress(fixture.url("/json"), JSON_ACCEPT),
      200,
    );
    expect(Object.keys(answer as object)).toEqual(["saveLink"]);
    expect(fieldsOfLink(answer)).toEqual({
      url: fixture.url("/json"),
      canonical_url: fixture.url("/canonical"),
      title: "Document title",
      description: "Meta description",
      og_title: "Sharing title",
      og_description: "Sharing description",
      og_site_name: "Example",
    });
  });

  it("gives the save link with the address alone when the lookup gives nothing", async () => {
    fixture.page("/json-bare", "<head></head>");
    const answer = await expectJsonAnswer(
      await postAddress(fixture.url("/json-bare"), JSON_ACCEPT),
      200,
    );
    expect(fieldsOfLink(answer)).toEqual({ url: fixture.url("/json-bare") });
    expect(lookupLogs()).toEqual(["Page lookup gave no metadata: no-metadata"]);
  });

  it("is given for any Accept that names application/json", async () => {
    fixture.page("/json-accept", FULL_PAGE);
    const response = await postAddress(fixture.url("/json-accept"), {
      accept: "text/html, Application/JSON; q=0.9",
    });
    expect(fieldsOfLink(await expectJsonAnswer(response, 200)).title).toBe("Document title");
  });

  it.each([
    ["application/json;q=0", "application/json;q=0"],
    ["application/json; q=0.0, with HTML acceptable", "text/html, application/json; q=0.0"],
  ])("is not given for %s, which says JSON is not acceptable", async (_, accept) => {
    fixture.page("/json-refused", FULL_PAGE);
    const response = await postAddress(fixture.url("/json-refused"), { accept });
    expect(response.status).toBe(303);
    expect(response.headers.get("content-type")).toBeNull();
  });

  it.each([
    ["an address without a scheme, which may stay", "pages.test/page", ADDRESS_RULE, true],
    ["an http: address, which may stay", "http://pages.test/page", ADDRESS_RULE, true],
    ["an empty address", "", "Enter the address of a page, starting with https://.", false],
    [
      "a flagged address, which must not stay",
      "https://pages.test/cb?access_token=secret-value",
      "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
      false,
    ],
    [
      "a value that carries a secret but is not an address, which must not stay",
      "access_token=secret-value",
      "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
      false,
    ],
  ])("rejects %s (400) with its error, and fetches nothing", async (_, url, error, keepValue) => {
    const response = await postAddress(url, JSON_ACCEPT);
    const text = await response.clone().text();
    // The title is the one the address form's page has with an error, so the script can match it.
    expect(await expectJsonAnswer(response, 400)).toEqual({
      error,
      keepValue,
      title: "Check the address - Haystack",
    });
    expect(text).not.toContain("secret-value");
    expect(fixture.requests).toHaveLength(0);
  });

  it("is refused with 401 when signed out, as every signed-out POST is, and fetches nothing", async () => {
    fixture.page("/json-signed-out", FULL_PAGE);
    const response = await postAddress(fixture.url("/json-signed-out"), {
      ...JSON_ACCEPT,
      cookie: null,
    });
    expect(response.status).toBe(401);
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    ["from another origin", { origin: "https://evil.test" }],
    ["without an Origin header", { origin: null }],
  ])("is refused (403) for a POST %s, and fetches nothing", async (_, headers) => {
    fixture.page("/json-origin", FULL_PAGE);
    const response = await postAddress(fixture.url("/json-origin"), { ...JSON_ACCEPT, ...headers });
    expect(response.status).toBe(403);
    expect(fixture.requests).toHaveLength(0);
  });

  it("leaves the answer without JavaScript as it was: a 303 to the save link", async () => {
    fixture.page("/no-json", FULL_PAGE);
    const json = await expectJsonAnswer(
      await postAddress(fixture.url("/no-json"), JSON_ACCEPT),
      200,
    );
    const redirect = await postAddress(fixture.url("/no-json"), { accept: "text/html" });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe((json as { saveLink: string }).saveLink);
  });
});

// A test that sends a request to an address it did not plan for fails, whatever the Worker does
// with the failed request. This shows the check that afterEach makes.
describe("the page fixture", () => {
  it("records a request to an address outside .test as unplanned, and fails it", async () => {
    const response = await postAddress("https://example.com/page-marker");
    expect(savedLinkFields(response)).toEqual({ url: "https://example.com/page-marker" });
    expect(fixture.unplanned).toEqual(["https://example.com/page-marker"]);
    fixture.reset();
  });
});
