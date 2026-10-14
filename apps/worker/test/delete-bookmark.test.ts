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
let bookmarkId: string;
const url = "https://example.com/guide";

beforeEach(async () => {
  const DB = await db();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
  bookmarkId = await seedBookmark(DB, owner.userId, url, normalizeUrl(url), { title: "A guide" });
});

function postDelete(
  id: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return server.fetch(`/bookmarks/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    headers: { origin, cookie: owner.cookie, ...headers },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const confirmed = { confirm: "yes" };

// The 404 for a bookmark the user cannot delete, from an ID that never existed.
async function notSavedMarkup(): Promise<string> {
  return (await postDelete(crypto.randomUUID(), confirmed)).text();
}

async function bookmarkIds(): Promise<unknown[]> {
  const { results } = await (await db()).prepare("SELECT id FROM bookmarks").all();
  return results.map((row: { id: unknown }) => row.id);
}

describe("POST /bookmarks/:id/delete", () => {
  it("shows a confirmation page without deleting when not yet confirmed", async () => {
    const response = await postDelete(bookmarkId, {});
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Delete this link?</h1>");
    expect(markup).toContain("<p><strong>Title:</strong> A guide</p>");
    expect(markup).toContain(`<p><strong>Address:</strong> ${url}</p>`);
    expect(markup).toContain('<input type="hidden" name="confirm" value="yes">');
    expect(markup).toContain(`<a href="/#bookmark-${bookmarkId}">`);
    expect(markup.match(/<button/g)).toHaveLength(1);
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("does not delete for a body that is not a form", async () => {
    const response = await server.fetch(`/bookmarks/${bookmarkId}/delete`, {
      method: "POST",
      headers: { origin, cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify(confirmed),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Delete this link?</h1>");
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("deletes when confirmed and shows the list saying what was deleted", async () => {
    const other = await seedBookmark(await db(), owner.userId, "https://example.com/other", "x");
    const response = await postDelete(bookmarkId, confirmed);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<div id="list-status" role="status"><p>Deleted “A guide”.</p></div>');
    expect(markup).toContain("<title>Deleted “A guide” - Saved links - Haystack</title>");
    expect(markup).not.toContain(`bookmark-${bookmarkId}`);
    expect(markup).toContain(`bookmark-${other}`);
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([other]);
  });

  it("renders a deleted title containing markup as text", async () => {
    const DB = await db();
    const id = await seedBookmark(DB, owner.userId, "https://example.com/x", "y", {
      title: "<b>bold</b>",
    });
    const markup = await (await postDelete(id, confirmed)).text();
    expect(markup).toContain("Deleted “&lt;b&gt;bold&lt;/b&gt;”.");
  });

  describe.each([
    ["not yet confirmed", {}],
    ["confirmed", confirmed],
  ])("for another user's bookmark, %s", (_, fields) => {
    it("returns 404 and changes nothing", async () => {
      const second = await seedSignedInUser(await db(), "second@example.com");
      const response = await postDelete(bookmarkId, fields, { cookie: second.cookie });
      expect(response.status).toBe(404);
      const markup = await response.text();
      expect(markup).toBe(await notSavedMarkup());
      expect(markup).not.toContain("A guide");
      expect(await bookmarkIds()).toEqual([bookmarkId]);
    });
  });

  it.each([
    ["not yet confirmed", {}],
    ["confirmed", confirmed],
  ])("returns 404 for a bookmark that does not exist, %s", async (_, fields) => {
    const response = await postDelete(crypto.randomUUID(), fields);
    expect(response.status).toBe(404);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("explains a 404 when the bookmark was already deleted, as a reload does", async () => {
    await postDelete(bookmarkId, confirmed);
    const response = await postDelete(bookmarkId, confirmed);
    expect(response.status).toBe(404);
    const markup = await response.text();
    expect(markup).toContain("<h1>This link isn't in your saved links</h1>");
    expect(markup).toContain('<a href="/">Go to your saved links</a>');
    await expectValidHtml(markup);
  });

  it.each([
    ["malformed percent-encoding", "/bookmarks/%E0%A4%A/delete"],
    ["an encoded slash", "/bookmarks/a%2Fb/delete"],
  ])("returns 404 for a path with %s", async (_, path) => {
    const response = await server.fetch(path, {
      method: "POST",
      headers: { origin, cookie: owner.cookie },
      body: new URLSearchParams(confirmed),
    });
    expect(response.status).toBe(404);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("rejects a cross-origin delete", async () => {
    const response = await postDelete(bookmarkId, confirmed, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("does not delete without a session", async () => {
    const response = await postDelete(bookmarkId, confirmed, { cookie: "" });
    expect(response.status).toBe(401);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("does not answer GET", async () => {
    const response = await server.fetch(`/bookmarks/${bookmarkId}/delete`, {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(404);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  it("lets the URL be saved again after deletion", async () => {
    await postDelete(bookmarkId, confirmed);
    const response = await server.fetch("/save", {
      method: "POST",
      headers: { origin, cookie: owner.cookie },
      body: new URLSearchParams({ url, confirmed_title: "A guide, again" }),
    });
    expect(await response.text()).toContain("<h1>Saved</h1>");
    expect(await bookmarkIds()).toHaveLength(1);
  });
});

describe("the list's delete buttons", () => {
  it("post to the delete endpoint, named by the delete label and the title", async () => {
    const response = await server.fetch("/", {
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    const markup = await response.text();
    expect(markup).toContain(`<form method="post" action="/bookmarks/${bookmarkId}/delete">`);
    expect(markup).toContain(
      `<button type="submit" id="delete-${bookmarkId}" aria-labelledby="delete-${bookmarkId} title-${bookmarkId}">Delete</button>`,
    );
    expect(markup).toContain(`<h2 id="title-${bookmarkId}">`);
  });
});
