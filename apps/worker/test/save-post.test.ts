import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
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

// What the form from GET /save submits for this captured page.
const submission = {
  url: "https://example.com/article?id=7",
  canonical_url: "https://example.com/article?id=7",
  title: "Document title",
  description: "Meta description",
  og_title: "Sharing title",
  og_description: "Sharing description",
  og_site_name: "Example",
  confirmed_title: "  My title  ",
  confirmed_description: "My description",
};

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return server.fetch("/save", {
    method: "POST",
    headers: { origin, cookie: owner.cookie, ...headers },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function bookmarks(): Promise<Record<string, unknown>[]> {
  const { results } = await (await db()).prepare("SELECT * FROM bookmarks").all();
  return results;
}

describe("POST /save", () => {
  it("creates the bookmark under the signed-in user with the confirmed values", async () => {
    const response = await post(submission);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Saved</h1>");
    await expectValidHtml(markup);

    const [bookmark] = await bookmarks();
    expect(bookmark).toMatchObject({
      user_id: owner.userId,
      url: "https://example.com/article?id=7",
      normalized_url: "https://example.com/article?id=7",
      title: "My title",
      description: "My description",
      canonical_url: "https://example.com/article?id=7",
      captured_title: "Document title",
      captured_description: "Meta description",
      og_title: "Sharing title",
      og_description: "Sharing description",
      og_site_name: "Example",
    });
    expect(bookmark?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(markup).toContain(`href="/#bookmark-${String(bookmark?.id)}"`);
  });

  it("stores no description when the confirmed description is empty", async () => {
    await post({ ...submission, confirmed_description: "   " });
    expect((await bookmarks())[0]?.description).toBeNull();
  });

  it("counts a submitted line break (CRLF) as one character, as the form's maxlength does", async () => {
    const description = "ab\r\n".repeat(100);
    expect(description).toHaveLength(400);
    const response = await post({ ...submission, confirmed_description: description });
    expect(response.status).toBe(200);
    expect((await bookmarks())[0]?.description).toBe("ab\n".repeat(100).trim());
  });

  it("accepts captured values whose line breaks arrive as CRLF, storing them as GET showed them", async () => {
    // GET rendered a 300-character description with 10 LF line breaks into a hidden input;
    // the browser submits each as CRLF, so the value arrives 10 characters longer.
    const shown = `${"a".repeat(29)}\n`.repeat(10);
    expect(shown).toHaveLength(300);
    const response = await post({ ...submission, description: shown.replaceAll("\n", "\r\n") });
    expect(response.status).toBe(200);
    expect((await bookmarks())[0]?.captured_description).toBe(shown.trim());
  });

  it("collapses line breaks in a tampered confirmed title", async () => {
    await post({ ...submission, confirmed_title: "Two\r\nlines" });
    expect((await bookmarks())[0]?.title).toBe("Two lines");
  });

  it.each([
    ["a JSON body", "application/json", JSON.stringify(submission)],
    ["a plain text body", "text/plain", "hello"],
  ])("answers %s with a 400 page", async (_, contentType, body) => {
    const response = await server.fetch("/save", {
      method: "POST",
      headers: { origin, cookie: owner.cookie, "content-type": contentType },
      body,
    });
    expect(response.status).toBe(400);
    await expectValidHtml(await response.text());
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    [
      "an empty title",
      { confirmed_title: "   " },
      "confirmed-title",
      "Enter a title of up to 200 characters.",
    ],
    [
      "a title over its cap",
      { confirmed_title: "a".repeat(201) },
      "confirmed-title",
      "Enter a title of up to 200 characters.",
    ],
    [
      "a description over its cap",
      { confirmed_description: "a".repeat(301) },
      "confirmed-description",
      "Shorten the description to 300 characters or fewer.",
    ],
  ])("shows the form again for %s, keeping the values", async (_, fields, id, message) => {
    const response = await post({ ...submission, ...fields });
    expect(response.status).toBe(400);
    const markup = await response.text();
    // The alert wraps the error. The paragraph the field points at has no live-region role of its
    // own, because VoiceOver does not read the description of such an element.
    expect(markup).toContain(`<div role="alert"><p id="save-error">${message}</p></div>`);
    expect(markup).toMatch(
      new RegExp(`id="${id}"[^>]*aria-invalid="true" aria-describedby="save-error"`),
    );
    expect(markup).toContain('name="og_title" value="Sharing title"');
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(0);
  });

  it("removes tracking parameters, even when the hidden input was tampered with", async () => {
    await post({ ...submission, url: "https://example.com/article?id=7&utm_source=mail&fbclid=x" });
    expect((await bookmarks())[0]?.url).toBe("https://example.com/article?id=7");
  });

  it("ignores a user_id in the form", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await post({ ...submission, user_id: other.userId });
    expect((await bookmarks())[0]?.user_id).toBe(owner.userId);
  });

  it("lets two users save the same URL independently", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await post(submission);
    await post(submission, { cookie: other.cookie });
    expect(new Set((await bookmarks()).map((b) => b.user_id))).toEqual(
      new Set([owner.userId, other.userId]),
    );
  });

  it("shows already saved for a URL the user saved before", async () => {
    await post(submission);
    const response = await post({ ...submission, url: "https://example.com/article?id=7#again" });
    const markup = await response.text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(1);
  });

  it("gives one bookmark and an already-saved result for two concurrent submissions", async () => {
    const responses = await Promise.all([post(submission), post(submission)]);
    const headings = await Promise.all(
      responses.map(async (r) => /<h1>([^<]*)<\/h1>/.exec(await r.text())?.[1]),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(headings)).toEqual(new Set(["Saved", "You already saved this link"]));
    expect(await bookmarks()).toHaveLength(1);
  });

  it.each([
    ["without a session", { cookie: "" }, 401],
    ["from another origin", { origin: "https://evil.example" }, 403],
  ])("is rejected %s", async (_, headers, status) => {
    const response = await post(submission, headers);
    expect(response.status).toBe(status);
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    ["a javascript: URL", { url: "javascript:alert(1)" }],
    ["a data: URL", { url: "data:text/html,hi" }],
    ["an http: URL", { url: "http://example.com/" }],
  ])("rejects %s", async (_, fields) => {
    const response = await post({ ...submission, ...fields });
    expect(response.status).toBe(400);
    await expectValidHtml(await response.text());
    expect(await bookmarks()).toHaveLength(0);
  });

  // The detect-then-strip order cannot be observed today: no tracking key is also a signal.
  it("refuses a tampered sensitive URL without echoing it", async () => {
    const response = await post({
      ...submission,
      url: "https://example.com/cb?utm_source=x&access_token=secret-value",
    });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).not.toContain("secret-value");
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    ["a credential parameter", "https://example.com/share?api_key=secret-value"],
    ["a fragment credential", "https://example.com/cb#access_token=secret-value"],
    ["embedded credentials", "https://user:secret-value@example.com/"],
  ])("saves the bookmark without a canonical URL that has %s", async (_, canonical_url) => {
    const response = await post({ ...submission, canonical_url });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Saved</h1>");
    expect(markup).not.toContain("secret-value");

    const rows = await bookmarks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: "https://example.com/article?id=7",
      canonical_url: null,
      captured_title: "Document title",
      og_title: "Sharing title",
    });
    expect(JSON.stringify(rows)).not.toContain("secret-value");
  });
});
