import { normalizeUrl } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { mainContent } from "./main-content.ts";
import { expectValidHtml } from "./validate-html.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
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
    expect(markup).toContain(
      `<p><strong>Address:</strong> <span class="address">${url}</span></p>`,
    );
    expect(markup).toContain('<input type="hidden" name="confirm" value="yes">');
    expect(markup).toContain(
      `<a href="/saved-links#bookmark-${bookmarkId}">Keep it and go back to your saved links</a>`,
    );
    // The page's own button. The header's Sign out button is outside <main>.
    expect(mainContent(markup).match(/<button/g)).toHaveLength(1);
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
    expect(markup).toContain(
      '<div id="list-status" class="status" role="status"><p>Deleted “A guide”.</p></div>',
    );
    expect(markup).toContain("<title>Deleted “A guide” - Saved links - Haystack</title>");
    expect(markup).toContain('<h1 id="list-heading">Saved links</h1>');
    expect(markup).toContain(
      '<a class="nav-link" href="/saved-links" aria-current="page">Saved links</a>',
    );
    expect(markup).not.toContain(`bookmark-${bookmarkId}`);
    expect(markup).toContain(`bookmark-${other}`);
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([other]);
  });

  // This Worker has no `search-enabled` flag, so search is switched off, and `/` sends the user
  // on to the saved links (#235). search-page.test.ts checks the return with search on.
  it("returns to the saved links from a search result while search is switched off", async () => {
    const response = await postDelete(bookmarkId, { ...confirmed, return_to: "/" });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Deleted “A guide” - Saved links - Haystack</title>");
    expect(markup).toContain(
      '<div id="list-status" class="status" role="status"><p>Deleted “A guide”.</p></div>',
    );
    expect(await bookmarkIds()).toEqual([]);
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
    expect(markup).toContain('<a href="/saved-links">Go to your saved links</a>');
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

  // The dialog's script sends fetch()'s default Accept, so it gets the 401 it says "signed out"
  // for (delete-dialog.js).
  it("does not delete without a session, and answers a script with 401", async () => {
    const response = await postDelete(bookmarkId, confirmed, { cookie: "", accept: "*/*" });
    expect(response.status).toBe(401);
    expect(await bookmarkIds()).toEqual([bookmarkId]);
  });

  // A form submission asks for HTML. A POST cannot be repeated by returning to its path, so the
  // user returns to the saved links after sign-in (#34).
  it.each([
    ["the list's Delete button", {}],
    ["the confirmation page's Delete button", confirmed],
  ])("sends %s through sign-in to the saved links, without a session", async (_, fields) => {
    const response = await postDelete(bookmarkId, fields, {
      cookie: "",
      accept: "text/html,application/xhtml+xml",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/saved-links")}`,
    );
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
    const response = await server.fetch("/saved-links", {
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    const markup = await response.text();
    // The attribute is how the dialog script tells a Delete button's form from the page's others.
    expect(markup).toContain(
      `<form method="post" action="/bookmarks/${bookmarkId}/delete" data-delete-form>`,
    );
    expect(markup).toContain(
      `<button class="button button-small button-danger-outline" type="submit" id="delete-${bookmarkId}" aria-labelledby="delete-${bookmarkId} title-${bookmarkId}">Delete</button>`,
    );
    expect(markup).toContain(`<h2 id="title-${bookmarkId}">`);
  });
});
