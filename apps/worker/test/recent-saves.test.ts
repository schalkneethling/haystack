import { normalizeUrl } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { RECENT_SAVES_LIMIT } from "../src/recent-saves.ts";
import {
  seedBookmark,
  seedBookmarks,
  type SeededBookmarkFields,
  seedSignedInUser,
  type SeededUser,
} from "./seed.ts";
import { mainContent } from "./main-content.ts";
import { expectValidHtml } from "./validate-html.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
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

async function save(url: string, fields: SeededBookmarkFields = {}, user = owner) {
  return seedBookmark(await db(), user.userId, url, normalizeUrl(url), fields);
}

// Seeds one bookmark per entry in a single database call, in order, and returns their ids (#161).
async function saveMany(entries: { url: string; createdAt?: number }[], user = owner) {
  const now = Date.now();
  return seedBookmarks(
    await db(),
    user.userId,
    entries.map(({ url, createdAt = now }) => ({
      url,
      normalizedUrl: normalizeUrl(url),
      createdAt,
    })),
  );
}

async function getList(cookie: string | null = owner.cookie) {
  return server.fetch("/saved-links", {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

async function listMarkup(): Promise<string> {
  const response = await getList();
  expect(response.status).toBe(200);
  return response.text();
}

function itemIds(markup: string): string[] {
  return [...markup.matchAll(/<li id="bookmark-([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("GET /saved-links", () => {
  it("redirects to sign-in without a session, and returns to the saved links", async () => {
    const response = await getList(null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fsaved-links");
  });

  // The list has its own heading (#245), after the address form, so the empty state and the cards,
  // whose titles are h3s, are under it rather than under "Save a link".
  it("gives the list its own h2, before the empty state, and the cards h3 titles", async () => {
    const heading = '<h2 id="saved-list-heading" class="cards-heading">Recently saved</h2>';
    const empty = mainContent(await listMarkup());
    expect(empty.indexOf("</form>")).toBeLessThan(empty.indexOf(heading));
    expect(empty.indexOf(heading)).toBeLessThan(empty.indexOf('id="empty-state"'));
    await save("https://example.com/list-heading");
    const listed = mainContent(await listMarkup());
    expect(listed).toContain(
      '<ol id="recent-saves" class="cards" aria-labelledby="saved-list-heading">',
    );
    expect(listed.indexOf(heading)).toBeLessThan(listed.indexOf("<ol"));
    expect(listed).toMatch(/<h3 id="title-[^"]+">/);
  });

  it("shows the empty state when nothing is saved", async () => {
    const markup = await listMarkup();
    expect(markup).toContain('<h1 id="list-heading">Saved links</h1>');
    expect(markup).toContain("You haven't saved any links yet.");
    expect(markup).not.toContain("<ol");
    await expectValidHtml(markup);
  });

  it("shows only the signed-in user's bookmarks", async () => {
    const second = await seedSignedInUser(await db(), "second@example.com");
    const mine = await save("https://example.com/mine");
    await save("https://example.com/theirs", {}, second);
    expect(itemIds(await listMarkup())).toEqual([mine]);
  });

  it("lists bookmarks newest first", async () => {
    const oldest = await save("https://example.com/a", { createdAt: 1_000 });
    const newest = await save("https://example.com/b", { createdAt: 3_000 });
    const middle = await save("https://example.com/c", { createdAt: 2_000 });
    expect(itemIds(await listMarkup())).toEqual([newest, middle, oldest]);
  });

  it("shows the title as a link, the address, the description, and the date saved", async () => {
    const id = await save("https://example.com/guide?page=2", {
      title: "A guide",
      description: "How to do the thing.",
      createdAt: Date.UTC(2026, 9, 13, 23, 30),
    });
    const markup = await listMarkup();
    expect(markup).toContain(`<li id="bookmark-${id}">`);
    expect(markup).toContain(
      `<h3 id="title-${id}"><a href="https://example.com/guide?page=2" rel="noreferrer">A guide</a></h3>`,
    );
    expect(markup).toContain('<p class="address">https://example.com/guide?page=2</p>');
    expect(markup).toContain('<p class="card-description">How to do the thing.</p>');
    expect(markup).toContain('<time datetime="2026-10-13T23:30:00.000Z">October 13, 2026</time>');
    await expectValidHtml(markup);
  });

  it("leaves out the description when there is none", async () => {
    await save("https://example.com/", { title: "Home" });
    const item =
      /<li id="bookmark-[^"]+"[^>]*>([\s\S]*?)<\/li>/.exec(await listMarkup())?.[1] ?? "";
    // The date and the address.
    expect(item.match(/<p[\s>]/g)).toHaveLength(2);
  });

  it("renders a title and description containing markup as text, with the CSP header", async () => {
    await save("https://example.com/", {
      title: '<img src=x onerror="alert(1)">',
      description: "<script>alert(2)</script>",
    });
    const response = await getList();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const markup = await response.text();
    expect(markup).not.toContain("<img");
    // The only scripts are the dialog's module, the address form's and the message bar's.
    expect(markup.match(/<script/g)).toHaveLength(3);
    expect(markup).toContain('<script type="module" src="/assets/delete-dialog.js"></script>');
    expect(markup).toContain('<script type="module" src="/assets/address-form.js"></script>');
    expect(markup).toContain('<script type="module" src="/assets/message-bar.js"></script>');
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  it("does not link a stored address that is not https", async () => {
    await save("http://example.com/old", { title: "Saved before https only" });
    const markup = await listMarkup();
    expect(markup).toMatch(/<h3 id="title-[^"]+">Saved before https only<\/h3>/);
    expect(markup).not.toContain('href="http://example.com/old"');
    expect(markup).toContain('<p class="address">http://example.com/old</p>');
  });

  it("shows the sensitive URL notice", async () => {
    expect(await listMarkup()).toContain('<p id="sensitive-notice" class="notice">');
  });

  it(`shows the newest ${RECENT_SAVES_LIMIT} and says so when there are more`, async () => {
    const ids = await saveMany(
      Array.from({ length: RECENT_SAVES_LIMIT + 1 }, (_, index) => ({
        url: `https://example.com/${index}`,
        createdAt: index,
      })),
    );
    const markup = await listMarkup();
    expect(itemIds(markup)).toEqual(ids.slice(1).reverse());
    expect(markup).toContain(`This list shows only your ${RECENT_SAVES_LIMIT} most recent links.`);
    // The dialog script reveals this after deleting every shown link; older ones remain.
    expect(markup).toMatch(
      /<p id="empty-state" class="empty-state" hidden>\s*You deleted every link shown here\./,
    );
    await expectValidHtml(markup);
  });

  it(`shows all ${RECENT_SAVES_LIMIT} without mentioning the limit at exactly that many`, async () => {
    await saveMany(
      Array.from({ length: RECENT_SAVES_LIMIT }, (_, index) => ({
        url: `https://example.com/${index}`,
      })),
    );
    const markup = await listMarkup();
    expect(itemIds(markup)).toHaveLength(RECENT_SAVES_LIMIT);
    expect(markup).not.toContain("most recent links");
  });

  it("keeps line breaks in the description", async () => {
    await save("https://example.com/", { description: "First line\n<b>Second</b> line" });
    expect(await listMarkup()).toContain(
      '<p class="card-description">First line<br>&lt;b&gt;Second&lt;/b&gt; line</p>',
    );
  });

  it("answers HEAD like GET", async () => {
    const response = await server.fetch("/saved-links", {
      method: "HEAD",
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("the already-saved page", () => {
  async function alreadySaved(url: string): Promise<string> {
    const response = await server.fetch(`/save?${new URLSearchParams({ url }).toString()}`, {
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    const markup = await response.text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
    return markup;
  }

  it("links to the bookmark when the list shows it", async () => {
    const [id] = await saveMany([
      { url: "https://example.com/listed", createdAt: 1 },
      ...Array.from({ length: RECENT_SAVES_LIMIT - 1 }, (_, offset) => ({
        url: `https://example.com/${offset + 1}`,
        createdAt: 2 + offset,
      })),
    ]);
    expect(await alreadySaved("https://example.com/listed")).toContain(
      `<a href="/saved-links#bookmark-${id}">See it in your saved links</a>`,
    );
  });

  it(`explains when the bookmark is older than the newest ${RECENT_SAVES_LIMIT}`, async () => {
    const [id] = await saveMany([
      { url: "https://example.com/older", createdAt: 1 },
      ...Array.from({ length: RECENT_SAVES_LIMIT }, (_, offset) => ({
        url: `https://example.com/${offset + 1}`,
        createdAt: 2 + offset,
      })),
    ]);
    const markup = await alreadySaved("https://example.com/older");
    expect(markup).not.toContain(`bookmark-${id}`);
    expect(markup).toContain(`older than the ${RECENT_SAVES_LIMIT} most recent links`);
    expect(markup).toContain('<a href="/saved-links">your saved links</a>');
    await expectValidHtml(markup);
  });

  it("orders bookmarks saved at the same moment as the list does", async () => {
    const ids = await saveMany(
      Array.from({ length: RECENT_SAVES_LIMIT + 1 }, (_, index) => ({
        url: `https://example.com/${index}`,
        createdAt: 5,
      })),
    );
    const listed = new Set(itemIds(await listMarkup()));
    for (const [index, id] of ids.entries()) {
      const markup = await alreadySaved(`https://example.com/${index}`);
      expect(markup.includes(`bookmark-${id}`)).toBe(listed.has(id));
    }
  });
});
