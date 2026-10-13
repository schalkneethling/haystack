import { normalizeUrl } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
    },
  ],
});

beforeAll(async () => {
  await server.listen();
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

function saveUrl(fields: Record<string, string>): string {
  return `/save?${new URLSearchParams(fields).toString()}`;
}

async function getSave(fields: Record<string, string>, cookie: string | null = owner.cookie) {
  return server.fetch(saveUrl(fields), {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// The value of the named form control, as the browser would submit it. Expects `name` before
// `value`, as the Worker renders them.
function formValue(markup: string, name: string): string | undefined {
  const input = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(markup);
  const textarea = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([^<]*)</textarea>`).exec(markup);
  const raw = input?.[1] ?? textarea?.[1];
  return raw?.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

async function rowCounts(): Promise<Record<string, number>> {
  const DB = await db();
  const tables = ["users", "sessions", "auth_flows", "bookmarks"];
  const results = await DB.batch(tables.map((t) => DB.prepare(`SELECT count(*) AS n FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, results[i].results[0].n]));
}

const article = {
  url: "https://example.com/article?utm_source=feed&id=7#top",
  canonical_url: "https://example.com/article?id=7",
  title: "Document title",
  description: "Meta description",
  og_title: "Sharing title",
  og_description: "Sharing description",
  og_site_name: "Example",
};

describe("GET /save", () => {
  it("redirects to sign-in without a session, returning to the same URL", async () => {
    const response = await getSave(article, null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(saveUrl(article))}`,
    );
  });

  it("shows the form without writing anything", async () => {
    const before = await rowCounts();
    const response = await getSave(article);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<form method="post" action="/save">');
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });

  it("shows and submits the URL with tracking parameters removed", async () => {
    const markup = await (await getSave(article)).text();
    expect(markup).toContain('<span id="save-address">https://example.com/article?id=7#top</span>');
    expect(formValue(markup, "url")).toBe("https://example.com/article?id=7#top");
  });

  it("carries the raw captured values as hidden inputs", async () => {
    const markup = await (await getSave(article)).text();
    for (const name of [
      "canonical_url",
      "title",
      "description",
      "og_title",
      "og_description",
      "og_site_name",
    ]) {
      expect(formValue(markup, name), name).toBe(article[name as keyof typeof article]);
    }
  });

  it.each([
    ["the Open Graph values", article, "Sharing title", "Sharing description"],
    [
      "the document values",
      { url: article.url, title: "Document title", description: "Meta" },
      "Document title",
      "Meta",
    ],
    [
      "the URL when there is no title",
      { url: "https://example.com/a" },
      "https://example.com/a",
      "",
    ],
  ])("prefills from %s", async (_, fields, title, description) => {
    const markup = await (await getSave(fields)).text();
    expect(formValue(markup, "confirmed_title")).toBe(title);
    expect(formValue(markup, "confirmed_description")).toBe(description);
  });

  it("collapses line breaks in the title prefill, keeping the raw value", async () => {
    const markup = await (
      await getSave({ url: "https://example.com/", og_title: "Hello\nWorld" })
    ).text();
    expect(formValue(markup, "confirmed_title")).toBe("Hello World");
    expect(formValue(markup, "og_title")).toBe("Hello\nWorld");
  });

  it("cuts a long URL used as the title to the title cap", async () => {
    const url = `https://example.com/${"a".repeat(300)}`;
    expect(formValue(await (await getSave({ url })).text(), "confirmed_title")).toBe(
      url.slice(0, 200),
    );
  });

  it("does not split an emoji when cutting the URL used as the title", async () => {
    const prefix = `https://example.com/${"a".repeat(179)}`;
    expect(prefix).toHaveLength(199);
    const url = `${prefix}\u{1F600}${"b".repeat(10)}`;
    expect(formValue(await (await getSave({ url })).text(), "confirmed_title")).toBe(prefix);
  });

  it("describes the Save button with the address and the notice", async () => {
    expect(await (await getSave(article)).text()).toContain(
      'aria-describedby="save-address sensitive-notice"',
    );
  });

  it("shows the sensitive URL notice", async () => {
    expect(await (await getSave(article)).text()).toContain(
      "Do not save links that contain access tokens",
    );
  });

  it("renders a title containing markup as text, with the CSP header", async () => {
    const response = await getSave({
      url: "https://example.com/",
      og_title: '<img src=x onerror="alert(1)">',
    });
    const markup = await response.text();
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expectValidHtml(markup);
  });

  it.each([
    ["a javascript: URL", { url: "javascript:alert(1)" }],
    ["a data: URL", { url: "data:text/html,hi" }],
    ["an http: URL", { url: "http://example.com/" }],
    ["no URL", { title: "x" }],
    ["a title over its cap", { url: "https://example.com/", title: "a".repeat(201) }],
  ])("shows a validation page for %s", async (_, fields) => {
    const response = await getSave(fields);
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<h1>This link can't be saved</h1>");
    await expectValidHtml(markup);
  });

  it("explains that only https pages are saved", async () => {
    const markup = await (await getSave({ url: "http://example.com/" })).text();
    expect(markup).toContain("<li>The address of the page</li>");
    expect(markup).toContain("must be a complete https:// link");
  });

  it.each([
    ["an access token", "https://example.com/cb?access_token=secret-value", "access token"],
    [
      "a signed storage URL",
      "https://bucket.example/f?X-Amz-Signature=secret-value",
      "signed access key",
    ],
    ["embedded credentials", "https://user:secret-value@example.com/", "user name or password"],
  ])("refuses %s without echoing the URL", async (_, url, explanation) => {
    const response = await getSave({ url });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain(explanation);
    expect(markup).not.toContain("secret-value");
    await expectValidHtml(markup);
  });

  // The detect-then-strip order cannot be observed today: no tracking key is also a signal.
  it("refuses a credential parameter next to tracking parameters", async () => {
    const response = await getSave({
      url: "https://example.com/?utm_source=x&api_key=secret-value",
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["the same URL", "https://example.com/article?id=7"],
    ["a URL with tracking parameters", "https://example.com/article?id=7&utm_source=mail"],
    ["a URL with a fragment", "https://example.com/article?id=7#comments"],
  ])("links to the bookmark when %s is already saved", async (_, submitted) => {
    const id = await seedBookmark(
      await db(),
      owner.userId,
      "https://example.com/article?id=7",
      normalizeUrl("https://example.com/article?id=7"),
    );
    const response = await getSave({ url: submitted });
    const markup = await response.text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
    expect(markup).toContain(`href="/#bookmark-${id}"`);
    await expectValidHtml(markup);
  });

  it("does not log the query string", async () => {
    server.clearLogs();
    await getSave({
      url: "https://example.com/private-marker-path",
      title: "private-marker-title",
    });
    await getSave({ url: "javascript:private-marker-invalid" });
    expect(JSON.stringify(server.getLogs())).not.toContain("private-marker");
  });

  it("does not treat another user's bookmark as already saved", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await seedBookmark(
      await db(),
      other.userId,
      "https://example.com/a",
      normalizeUrl("https://example.com/a"),
    );
    const markup = await (await getSave({ url: "https://example.com/a" })).text();
    expect(markup).toContain('<form method="post" action="/save">');
  });
});
