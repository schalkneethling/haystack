// The review page at /held and its actions (#129): Release for a Held bookmark, Retry for a
// Failed one, and Delete, which returns here. See "Reviewing Held bookmarks" in the plan.
import { normalizeUrl } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDb, type Db } from "../src/db/client.ts";
import { selectBookmarksToEnrich } from "../src/enrichment/enrich-pending.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import { readSensitiveWarnThreshold } from "../src/enrichment/state.ts";
import { failureInPlainWords } from "../src/held.ts";
import { readSweepAttemptLimit } from "../src/scheduled.ts";
import { mainContent } from "./main-content.ts";
import {
  seedBookmark,
  seedEnrichment,
  seedEnrichmentFailure,
  type SeededBookmarkFields,
  seedSignedInUser,
  type SeededUser,
} from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
});

let origin: string;
let db: Db;
// From wrangler.jsonc, as the Worker reads them.
let threshold: number;
let attemptLimit: number;

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  db = createDb(env.DB);
  // The harness types its env as `any`-like, without the vars' names.
  const SENSITIVE_WARN_THRESHOLD: string = env.SENSITIVE_WARN_THRESHOLD;
  const SWEEP_ATTEMPT_LIMIT: string = env.SWEEP_ATTEMPT_LIMIT;
  threshold = readSensitiveWarnThreshold({ SENSITIVE_WARN_THRESHOLD });
  attemptLimit = readSweepAttemptLimit({ SWEEP_ATTEMPT_LIMIT });
});

afterAll(async () => {
  await server.close();
});

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

let owner: SeededUser;

beforeEach(async () => {
  const DB = await d1();
  // Enrichments and failure records go with their bookmarks.
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

// A schema version before the current one, as failure records have after it is raised.
const OLDER_VERSION = ENRICHMENT_SCHEMA_VERSION - 1;

async function save(url: string, fields: SeededBookmarkFields = {}, user = owner) {
  return seedBookmark(await d1(), user.userId, url, normalizeUrl(url), fields);
}

/** A bookmark that Jev judged at the threshold or above, and that nobody released. */
async function saveHeld(url: string, fields: SeededBookmarkFields = {}, user = owner) {
  return save(url, { sensitivityNoul: threshold, sensitivityCheckedAt: 1, ...fields }, user);
}

/** A bookmark whose failure record at the current version has reached the attempt limit. */
async function saveFailed(
  url: string,
  fields: SeededBookmarkFields = {},
  user = owner,
  lastError = "llm:timeout",
) {
  const id = await save(url, fields, user);
  await seedEnrichmentFailure(
    await d1(),
    id,
    ENRICHMENT_SCHEMA_VERSION,
    attemptLimit,
    attemptLimit,
    Date.now(),
    lastError,
  );
  return id;
}

async function getHeld(cookie: string | null = owner.cookie) {
  return server.fetch("/held", {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

async function heldMarkup(): Promise<string> {
  const response = await getHeld();
  expect(response.status).toBe(200);
  return response.text();
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return server.fetch(path, {
    method: "POST",
    headers: { origin, cookie: owner.cookie, ...headers },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const notPrivate = { not_private: "yes" };
const fromHeld = { return_to: "/held" };
const confirmed = { confirm: "yes" };

function release(id: string, fields: Record<string, string> = notPrivate, headers = {}) {
  return post(`/bookmarks/${encodeURIComponent(id)}/release`, fields, headers);
}

function retry(id: string, headers = {}) {
  return post(`/bookmarks/${encodeURIComponent(id)}/retry`, {}, headers);
}

function deleteFromHeld(id: string, fields: Record<string, string> = {}, headers = {}) {
  return post(`/bookmarks/${encodeURIComponent(id)}/delete`, { ...fromHeld, ...fields }, headers);
}

// The ids of each section's items, in order.
function sectionIds(markup: string, section: "held" | "failed"): string[] {
  const list = new RegExp(`<ol id="${section}-list"[^>]*>([\\s\\S]*?)</ol>`).exec(markup)?.[1];
  return [...(list ?? "").matchAll(/<li id="bookmark-([^"]+)"/g)].map((match) => match[1] ?? "");
}

// The markup of one item.
function itemMarkup(markup: string, id: string): string {
  return new RegExp(`<li id="bookmark-${id}">([\\s\\S]*?)</li>`).exec(markup)?.[1] ?? "";
}

// The 404 every bookmark route gives a bookmark the user can't act on, from the delete endpoint
// and an ID that never existed.
async function notSavedMarkup(): Promise<string> {
  return (await post(`/bookmarks/${crypto.randomUUID()}/delete`, confirmed)).text();
}

async function acknowledgedAt(id: string): Promise<unknown> {
  const row = await (
    await d1()
  )
    .prepare("SELECT sensitivity_acknowledged_at AS at FROM bookmarks WHERE id = ?")
    .bind(id)
    .first();
  return row?.at;
}

async function failureVersions(id: string): Promise<unknown[]> {
  const { results } = await (
    await d1()
  )
    .prepare(
      "SELECT schema_version FROM enrichment_failures WHERE bookmark_id = ? ORDER BY schema_version",
    )
    .bind(id)
    .all();
  return results.map((row: { schema_version: unknown }) => row.schema_version);
}

// The bookmarks the sweep's next run would pick.
async function sweepSelection(): Promise<string[]> {
  const { bookmarks } = await selectBookmarksToEnrich(db, {
    batchSize: 20,
    attemptLimit,
    sensitiveWarnThreshold: threshold,
    now: Date.now(),
  });
  return bookmarks.map(({ id }) => id);
}

describe("GET /held", () => {
  it("sends a signed-out visitor through sign-in, back to /held", async () => {
    const response = await getHeld(null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fheld");
  });

  it("shows the empty state when nothing needs review", async () => {
    const markup = await heldMarkup();
    expect(markup).toContain("<title>Links to review - Haystack</title>");
    expect(markup).toContain('<h1 id="list-heading">Links to review</h1>');
    expect(markup).toMatch(
      /<div id="empty-state" class="empty-state">\s*<p><strong>Nothing to review\.<\/strong>/,
    );
    expect(markup).toContain('<a href="/">Go to your saved links</a>');
    expect(markup).not.toContain("<section");
    expect(markup).not.toContain("<ol");
    await expectValidHtml(markup);
  });

  it("leaves out every bookmark that is neither Held nor Failed", async () => {
    const DB = await d1();
    await save("https://example.com/pending");
    await save("https://example.com/below", { sensitivityNoul: threshold / 2 });
    await saveHeld("https://example.com/released", { sensitivityAcknowledgedAt: 1 });
    const current = await save("https://example.com/current");
    await seedEnrichment(DB, current, ENRICHMENT_SCHEMA_VERSION);
    const belowLimit = await save("https://example.com/below-limit");
    await seedEnrichmentFailure(DB, belowLimit, ENRICHMENT_SCHEMA_VERSION, attemptLimit - 1);
    // Attempts count per version, so a record at an older one leaves the bookmark Pending.
    const olderVersion = await save("https://example.com/older-version");
    await seedEnrichmentFailure(DB, olderVersion, OLDER_VERSION, attemptLimit);
    const markup = await heldMarkup();
    expect(markup).not.toContain("<section");
    expect(markup).not.toContain('<li id="bookmark-');
    expect(markup).toMatch(/<div id="empty-state" class="empty-state">/);
  });

  it("lists only the signed-in user's Held and Failed bookmarks, newest first", async () => {
    const second = await seedSignedInUser(await d1(), "second@example.com");
    const olderHeld = await saveHeld("https://example.com/held-1", { createdAt: 1_000 });
    const newerHeld = await saveHeld("https://example.com/held-2", { createdAt: 2_000 });
    const failed = await saveFailed("https://example.com/failed");
    await saveHeld("https://example.com/theirs-held", {}, second);
    await saveFailed("https://example.com/theirs-failed", {}, second);
    const markup = await heldMarkup();
    expect(sectionIds(markup, "held")).toEqual([newerHeld, olderHeld]);
    expect(sectionIds(markup, "failed")).toEqual([failed]);
    expect(markup).toContain('<div id="empty-state" class="empty-state" hidden>');
    await expectValidHtml(markup);
  });

  it("shows a bookmark that is Held and at the attempt limit as Held only, as the sweep does", async () => {
    const id = await saveFailed("https://example.com/both", {
      sensitivityNoul: threshold,
      sensitivityCheckedAt: 1,
    });
    const markup = await heldMarkup();
    expect(sectionIds(markup, "held")).toEqual([id]);
    expect(sectionIds(markup, "failed")).toEqual([]);
    expect(markup).not.toContain('id="failed-heading"');
  });

  it("shows a Held bookmark's title and host, never its address, with Release and Delete", async () => {
    const id = await saveHeld("https://drive.example.com/share/9f8e7d6c?key=s3cret", {
      title: "A shared folder",
      createdAt: Date.UTC(2026, 9, 13, 23, 30),
    });
    const markup = await heldMarkup();
    expect(markup).toContain('<h2 id="held-heading">Held back</h2>');
    const item = itemMarkup(markup, id);
    expect(item).toContain('<time datetime="2026-10-13T23:30:00.000Z">October 13, 2026</time>');
    expect(item).toContain(`<h3 id="title-${id}">A shared folder</h3>`);
    expect(item).toContain('<p class="address">drive.example.com</p>');
    expect(markup).not.toContain("9f8e7d6c");
    expect(markup).not.toContain("s3cret");
    expect(item).toContain(
      `<form class="release-form" method="post" action="/bookmarks/${id}/release">`,
    );
    // The checkbox is described by the title, because every Held card's checkbox has the same
    // label.
    expect(item).toContain(
      `<input type="checkbox" id="not-private-${id}" name="not_private" value="yes" required aria-describedby="title-${id}">`,
    );
    expect(item).toContain(
      `<label for="not-private-${id}">This link does not give access to anything private</label>`,
    );
    expect(item).toContain(`aria-labelledby="release-${id} title-${id}">Release</button>`);
    expect(item).toContain(
      `<form method="post" action="/bookmarks/${id}/delete" data-delete-form>`,
    );
    expect(item).toContain('<input type="hidden" name="return_to" value="/held">');
    expect(item).toContain(`aria-labelledby="delete-${id} title-${id}">Delete</button>`);
    await expectValidHtml(markup);
  });

  it("shows a Failed bookmark's title, host and last error in plain words, with Retry and Delete", async () => {
    const id = await saveFailed(
      "https://example.com/guide?page=2",
      { title: "A guide" },
      owner,
      "llm:invalid-output:use_cases.1: max_length",
    );
    const markup = await heldMarkup();
    expect(markup).toContain('<h2 id="failed-heading">Not described</h2>');
    const item = itemMarkup(markup, id);
    expect(item).toContain(`<h3 id="title-${id}">A guide</h3>`);
    expect(item).toContain('<p class="address">example.com</p>');
    expect(item).toContain(
      '<p class="card-error"><strong>Last error:</strong> Writing its description failed, because the description that came back wasn&#39;t in the shape Haystack needs.</p>',
    );
    // No part of the stored text is shown.
    expect(markup).not.toContain("invalid-output");
    expect(markup).not.toContain("use_cases");
    expect(item).toContain(`<form method="post" action="/bookmarks/${id}/retry">`);
    expect(item).toContain(`aria-labelledby="retry-${id} title-${id}">Retry</button>`);
    expect(item).toContain('<input type="hidden" name="return_to" value="/held">');
    await expectValidHtml(markup);
  });

  it("renders a title containing markup as text", async () => {
    await saveHeld("https://example.com/", { title: '<img src=x onerror="alert(1)">' });
    const markup = await heldMarkup();
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // The only script is the dialog's module.
    expect(markup.match(/<script/g)).toHaveLength(1);
    expect(markup).toContain('<script type="module" src="/assets/delete-dialog.js"></script>');
  });

  it("answers HEAD like GET", async () => {
    const response = await server.fetch("/held", {
      method: "HEAD",
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("failureInPlainWords", () => {
  it.each([
    [
      "sensitivity:timeout",
      "Checking whether the link is private failed, because the service took too long to answer.",
    ],
    [
      "sensitivity:network",
      "Checking whether the link is private failed, because Haystack couldn't reach the service.",
    ],
    [
      "kind:status:429",
      "Working out what kind of link it is failed, because the service answered with an error.",
    ],
    [
      "kind:invalid-response",
      "Working out what kind of link it is failed, because Haystack couldn't read the service's answer.",
    ],
    ["llm:refused", "Writing its description failed, because the service declined to answer."],
    [
      "llm:truncated",
      "Writing its description failed, because the description that came back was cut off.",
    ],
    [
      "llm:spend-limit",
      "Writing its description failed, because Haystack's account reached its spending limit.",
    ],
  ])("words %s from its codes alone", (lastError, words) => {
    expect(failureInPlainWords(lastError)).toBe(words);
  });

  it.each(["Seeded failure", "github:status:500", "llm:constructor", "toString:timeout", "", null])(
    "says only that it couldn't describe the link for %j",
    (lastError) => {
      expect(failureInPlainWords(lastError)).toBe("Haystack couldn't describe this link.");
    },
  );
});

describe("POST /bookmarks/:id/release", () => {
  it("records the acknowledgment, makes the bookmark eligible for the sweep, and says so", async () => {
    const id = await saveHeld("https://example.com/held", { title: "A guide" });
    const other = await saveHeld("https://example.com/other", { title: "Another guide" });
    expect(await sweepSelection()).toEqual([]);
    const before = Date.now();

    const response = await release(id);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Released “A guide” - Links to review - Haystack</title>");
    // The message doesn't take focus. The page title and the message carry the result.
    expect(markup).not.toContain("autofocus");
    expect(markup).toContain(
      '<div id="list-status" class="status" role="status"><p>Released “A guide”. Haystack can now describe it.</p></div>',
    );
    expect(sectionIds(markup, "held")).toEqual([other]);
    await expectValidHtml(markup);

    expect(await acknowledgedAt(id)).toBeGreaterThanOrEqual(before);
    expect(await acknowledgedAt(other)).toBeNull();
    expect(await sweepSelection()).toEqual([id]);
  });

  // Failed comes after Held in the state's order, so the sweep leaves it alone, and the message
  // says where it went.
  it("says a released bookmark at the attempt limit is now Failed, and lists it there", async () => {
    const id = await saveFailed("https://example.com/held-and-failed", {
      title: "A guide",
      sensitivityNoul: threshold,
      sensitivityCheckedAt: 1,
    });
    expect(sectionIds(await heldMarkup(), "held")).toEqual([id]);

    const response = await release(id);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Released “A guide” - Links to review - Haystack</title>");
    expect(markup).toContain(
      "<p>Released “A guide”. Haystack couldn&#39;t describe it before, so it&#39;s now under “Not described”, where you can retry it.</p>",
    );
    expect(sectionIds(markup, "held")).toEqual([]);
    expect(sectionIds(markup, "failed")).toEqual([id]);
    await expectValidHtml(markup);
    expect(await sweepSelection()).toEqual([]);
  });

  it("answers a bookmark released already as a release, and keeps the first time, as a reload does", async () => {
    const id = await saveHeld("https://example.com/held", {
      title: "A guide",
      sensitivityAcknowledgedAt: 5,
    });
    const response = await release(id);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "<p>Released “A guide”. Haystack can now describe it.</p>",
    );
    expect(await acknowledgedAt(id)).toBe(5);
  });

  // An acknowledgment means that the owner saw the link held back and released it. Set on a
  // bookmark that was never checked, it would skip the gate when Jev checks it later.
  it.each([
    ["Pending, below the threshold", { sensitivityNoul: 0, sensitivityCheckedAt: 1 }],
    ["never checked, with a NULL noul", {}],
  ])("writes nothing for a bookmark that is %s, and says it isn't held back", async (_, fields) => {
    const id = await save("https://example.com/not-held", { title: "A guide", ...fields });
    const response = await release(id);
    expect(response.status).toBe(409);
    const markup = await response.text();
    expect(markup).toContain(
      "<title>Nothing to release for “A guide” - Links to review - Haystack</title>",
    );
    expect(markup).toContain(
      "<p>“A guide” isn&#39;t held back, so there was nothing to release.</p>",
    );
    await expectValidHtml(markup);
    expect(await acknowledgedAt(id)).toBeNull();
  });

  it("leaves the last Held bookmark's page with only the empty state", async () => {
    const id = await saveHeld("https://example.com/held");
    const markup = await (await release(id)).text();
    expect(markup).not.toContain("<section");
    expect(markup).toMatch(/<div id="empty-state" class="empty-state">/);
  });

  it.each([
    ["without the checkbox", {}],
    ["with another value", { not_private: "on" }],
  ])("releases nothing %s, and says why", async (_, fields) => {
    const id = await saveHeld("https://example.com/held", { title: "A guide" });
    const response = await release(id, fields);
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<title>Not released “A guide” - Links to review - Haystack</title>");
    expect(markup).toContain(
      "<p>“A guide” was not released. Tick “This link does not give access to anything private” to release it.</p>",
    );
    expect(sectionIds(markup, "held")).toEqual([id]);
    await expectValidHtml(markup);
    expect(await acknowledgedAt(id)).toBeNull();
  });

  it("releases nothing for a body that is not a form", async () => {
    const id = await saveHeld("https://example.com/held");
    const response = await server.fetch(`/bookmarks/${id}/release`, {
      method: "POST",
      headers: { origin, cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify(notPrivate),
    });
    expect(response.status).toBe(400);
    expect(await acknowledgedAt(id)).toBeNull();
  });

  describe.each([
    ["confirmed", notPrivate],
    ["not confirmed", {}],
  ])("for another user's bookmark, %s", (_, fields) => {
    it("gets the delete's 404 page and changes nothing", async () => {
      const second = await seedSignedInUser(await d1(), "second@example.com");
      const id = await saveHeld("https://example.com/held", { title: "A guide" });
      const response = await release(id, fields, { cookie: second.cookie });
      expect(response.status).toBe(404);
      const markup = await response.text();
      expect(markup).toBe(await notSavedMarkup());
      expect(markup).not.toContain("A guide");
      expect(await acknowledgedAt(id)).toBeNull();
    });
  });

  it("returns 404 for a bookmark that does not exist", async () => {
    const response = await release(crypto.randomUUID());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(await notSavedMarkup());
  });

  it("rejects a cross-origin release", async () => {
    const id = await saveHeld("https://example.com/held");
    const response = await release(id, notPrivate, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await acknowledgedAt(id)).toBeNull();
  });

  it("sends a form submission without a session through sign-in, back to /held", async () => {
    const id = await saveHeld("https://example.com/held");
    const response = await release(id, notPrivate, { cookie: "", accept: "text/html" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fheld");
    expect(await acknowledgedAt(id)).toBeNull();
  });

  it("does not answer GET", async () => {
    const id = await saveHeld("https://example.com/held");
    const response = await server.fetch(`/bookmarks/${id}/release`, {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(404);
    expect(await acknowledgedAt(id)).toBeNull();
  });
});

describe("POST /bookmarks/:id/retry", () => {
  it("deletes the failure record at the current version, makes the bookmark eligible for the sweep, and says so", async () => {
    const id = await saveFailed("https://example.com/failed", { title: "A guide" });
    // Attempts at an older version are that version's, so they stay.
    await seedEnrichmentFailure(await d1(), id, OLDER_VERSION, attemptLimit);
    const other = await saveFailed("https://example.com/other", { title: "Another guide" });
    // Another user's record for the same address, which the deletion must not reach.
    const second = await seedSignedInUser(await d1(), "second@example.com");
    const theirs = await saveFailed("https://example.com/failed", {}, second);
    expect(await sweepSelection()).toEqual([]);

    const response = await retry(id);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Retrying “A guide” - Links to review - Haystack</title>");
    expect(markup).toContain(
      '<div id="list-status" class="status" role="status"><p>Retrying “A guide”. Haystack will try to describe it again soon.</p></div>',
    );
    expect(sectionIds(markup, "failed")).toEqual([other]);
    await expectValidHtml(markup);

    expect(await failureVersions(id)).toEqual([OLDER_VERSION]);
    expect(await failureVersions(other)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
    expect(await failureVersions(theirs)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
    // The record held the backoff window too, so the bookmark is tried in the next run.
    expect(await sweepSelection()).toEqual([id]);
  });

  // Deleting a record below the limit would reset the bookmark's backoff, and let it skip the
  // queue. A Held bookmark's record waits until it is released.
  it.each([
    ["below the attempt limit", {}, 1],
    ["Held, at the attempt limit", { sensitivityNoul: 1, sensitivityCheckedAt: 1 }, 0],
  ])(
    "writes nothing for a bookmark %s, and says it isn't waiting for a retry",
    async (_, fields, below) => {
      const id = await save("https://example.com/not-failed", { title: "A guide", ...fields });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, attemptLimit - below);
      const response = await retry(id);
      expect(response.status).toBe(409);
      const markup = await response.text();
      expect(markup).toContain(
        "<title>Nothing to retry for “A guide” - Links to review - Haystack</title>",
      );
      expect(markup).toContain("<p>“A guide” isn&#39;t waiting for a retry.</p>");
      await expectValidHtml(markup);
      expect(await failureVersions(id)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
    },
  );

  it("answers a bookmark without a failure record as a retry, with nothing to delete", async () => {
    const id = await save("https://example.com/pending", { title: "A guide" });
    const response = await retry(id);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "<title>Retrying “A guide” - Links to review - Haystack</title>",
    );
    expect(await failureVersions(id)).toEqual([]);
  });

  it("changes nothing more when it is sent again, as a reload does", async () => {
    const id = await saveFailed("https://example.com/failed", { title: "A guide" });
    await retry(id);
    const response = await retry(id);
    expect(response.status).toBe(200);
    expect(await failureVersions(id)).toEqual([]);
  });

  it("gets the delete's 404 page for another user's bookmark, and changes nothing", async () => {
    const second = await seedSignedInUser(await d1(), "second@example.com");
    const id = await saveFailed("https://example.com/failed", { title: "A guide" });
    const response = await retry(id, { cookie: second.cookie });
    expect(response.status).toBe(404);
    const markup = await response.text();
    expect(markup).toBe(await notSavedMarkup());
    expect(markup).not.toContain("A guide");
    expect(await failureVersions(id)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
  });

  it("returns 404 for a bookmark that does not exist", async () => {
    const response = await retry(crypto.randomUUID());
    expect(response.status).toBe(404);
  });

  it("rejects a cross-origin retry", async () => {
    const id = await saveFailed("https://example.com/failed");
    const response = await retry(id, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await failureVersions(id)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
  });

  it("sends a form submission without a session through sign-in, back to /held", async () => {
    const id = await saveFailed("https://example.com/failed");
    const response = await retry(id, { cookie: "", accept: "text/html" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fheld");
    expect(await failureVersions(id)).toEqual([ENRICHMENT_SCHEMA_VERSION]);
  });
});

describe("deleting from /held", () => {
  async function bookmarkIds(): Promise<unknown[]> {
    const { results } = await (await d1()).prepare("SELECT id FROM bookmarks").all();
    return results.map((row: { id: unknown }) => row.id);
  }

  it("asks first, and the confirmation returns to /held, or keeps the link there", async () => {
    const id = await saveHeld("https://drive.example.com/share/9f8e7d6c?key=s3cret", {
      title: "A guide",
    });
    const response = await deleteFromHeld(id);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Delete this link?</h1>");
    // The host only, as the card shows it, because the rest may be what makes the link private.
    expect(markup).toContain(
      '<p><strong>Site:</strong> <span class="address">drive.example.com</span></p>',
    );
    expect(markup).not.toContain("9f8e7d6c");
    expect(markup).not.toContain("s3cret");
    expect(markup).toContain('<input type="hidden" name="confirm" value="yes">');
    expect(markup).toContain('<input type="hidden" name="return_to" value="/held">');
    expect(markup).toContain(
      `<a href="/held#bookmark-${id}">Keep it and go back to the links to review</a>`,
    );
    // The page's own button. The header's Sign out button is outside <main>.
    expect(mainContent(markup).match(/<button/g)).toHaveLength(1);
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([id]);
  });

  it("deletes the bookmark with its related rows, and shows /held saying what was deleted", async () => {
    const DB = await d1();
    const id = await saveFailed("https://example.com/failed", { title: "A guide" });
    await seedEnrichment(DB, id, OLDER_VERSION);
    const kept = await saveHeld("https://example.com/held", { title: "Another guide" });
    const response = await deleteFromHeld(id, confirmed);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Deleted “A guide” - Links to review - Haystack</title>");
    expect(markup).toContain("<p>Deleted “A guide”.</p>");
    expect(sectionIds(markup, "held")).toEqual([kept]);
    expect(markup).not.toContain('id="failed-heading"');
    await expectValidHtml(markup);
    expect(await bookmarkIds()).toEqual([kept]);
    const { results: enrichments } = await DB.prepare(
      "SELECT id FROM enrichments WHERE bookmark_id = ?",
    )
      .bind(id)
      .all();
    expect(enrichments).toEqual([]);
    expect(await failureVersions(id)).toEqual([]);
  });

  it.each(["/", "/elsewhere", "https://evil.example/held", ""])(
    "returns to the saved links for the return page %j",
    async (returnTo) => {
      const id = await saveHeld("https://example.com/held", { title: "A guide" });
      const response = await post(`/bookmarks/${id}/delete`, { ...confirmed, return_to: returnTo });
      expect(await response.text()).toContain(
        "<title>Deleted “A guide” - Saved links - Haystack</title>",
      );
    },
  );

  it("gets the same 404 page for another user's bookmark", async () => {
    const second = await seedSignedInUser(await d1(), "second@example.com");
    const id = await saveHeld("https://example.com/held");
    const response = await deleteFromHeld(id, confirmed, { cookie: second.cookie });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(await notSavedMarkup());
    expect(await bookmarkIds()).toEqual([id]);
  });

  it("rejects a cross-origin delete", async () => {
    const id = await saveHeld("https://example.com/held");
    const response = await deleteFromHeld(id, confirmed, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await bookmarkIds()).toEqual([id]);
  });

  it.each([
    ["the card's Delete button", {}],
    ["the confirmation page's Delete button", confirmed],
  ])("sends %s through sign-in to /held, without a session", async (_, fields) => {
    const id = await saveHeld("https://example.com/held");
    const response = await deleteFromHeld(id, fields, { cookie: "", accept: "text/html" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fheld");
    expect(await bookmarkIds()).toEqual([id]);
  });
});

describe("the saved links page's link to /held", () => {
  async function listMarkup(): Promise<string> {
    const response = await server.fetch("/", {
      headers: { accept: "text/html", cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  it("is not shown when nothing needs review", async () => {
    await save("https://example.com/pending");
    await saveHeld("https://example.com/released", { sensitivityAcknowledgedAt: 1 });
    // Another user's Held bookmark isn't this user's to review.
    const second = await seedSignedInUser(await d1(), "second@example.com");
    await saveHeld("https://example.com/theirs", {}, second);
    const markup = await listMarkup();
    expect(markup).not.toContain('href="/held"');
    expect(markup).not.toContain('class="callout"');
  });

  it("says how many links there are to review, in one", async () => {
    await saveHeld("https://example.com/held");
    const markup = await listMarkup();
    expect(markup).toContain(
      '<p class="callout"><a href="/held">Review 1 link</a> that Haystack held back or couldn\'t describe.</p>',
    );
    await expectValidHtml(markup);
  });

  it("counts Held and Failed bookmarks together", async () => {
    await saveHeld("https://example.com/held");
    await saveFailed("https://example.com/failed-1");
    await saveFailed("https://example.com/failed-2");
    expect(await listMarkup()).toContain('<a href="/held">Review 3 links</a>');
  });
});

// A configuration the state can't be derived with. The sweep and /held refuse it rather than
// guess, and the saved links page goes on without the link.
describe("with an attempt limit that can't be read", () => {
  const misconfigured = createTestWorker({
    vars: { ALLOWED_EMAILS: "owner@example.com", SWEEP_ATTEMPT_LIMIT: "three" },
  });
  let user: SeededUser;
  let misconfiguredOrigin: string;
  let heldId: string;

  async function misconfiguredDb() {
    return (await misconfigured.getWorker().getEnv()).DB;
  }

  beforeAll(async () => {
    misconfiguredOrigin = (await misconfigured.listen()).url.origin;
    await misconfigured.getWorker().applyD1Migrations("DB");
    const DB = await misconfiguredDb();
    user = await seedSignedInUser(DB, "owner@example.com");
    heldId = await seedBookmark(DB, user.userId, "https://example.com/held", "held", {
      sensitivityNoul: 1,
      sensitivityCheckedAt: 1,
    });
    await seedEnrichmentFailure(DB, heldId, ENRICHMENT_SCHEMA_VERSION, 99);
  });

  function postMisconfigured(path: string, fields: Record<string, string>) {
    return misconfigured.fetch(path, {
      method: "POST",
      headers: { origin: misconfiguredOrigin, cookie: user.cookie, accept: "text/html" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  }

  async function heldRow(): Promise<Record<string, unknown> | null> {
    return (await misconfiguredDb())
      .prepare(
        "SELECT b.sensitivity_acknowledged_at AS at, f.attempts FROM bookmarks b LEFT JOIN enrichment_failures f ON f.bookmark_id = b.id WHERE b.id = ?",
      )
      .bind(heldId)
      .first();
  }

  // Each action reads the policy before it writes, so nothing changes.
  it.each([
    ["a delete that returns to /held", "delete", { ...confirmed, ...fromHeld }],
    ["a release", "release", notPrivate],
    ["a retry", "retry", {}],
  ])("answers %s with a 500, and changes nothing", async (_, action, fields) => {
    const response = await postMisconfigured(`/bookmarks/${heldId}/${action}`, fields);
    expect(response.status).toBe(500);
    expect(await heldRow()).toEqual({ at: null, attempts: 99 });
  });

  afterAll(async () => {
    await misconfigured.close();
  });

  it("answers /held with a 500", async () => {
    const response = await misconfigured.fetch("/held", {
      headers: { accept: "text/html", cookie: user.cookie },
    });
    expect(response.status).toBe(500);
  });

  it("shows the saved links without the link to /held", async () => {
    const response = await misconfigured.fetch("/", {
      headers: { accept: "text/html", cookie: user.cookie },
    });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<h1 id="list-heading">Saved links</h1>');
    expect(markup).not.toContain('href="/held"');
  });

  // Runs last, because it deletes the bookmark the other tests read.
  it("still deletes from the saved links, which don't need the policy", async () => {
    const response = await postMisconfigured(`/bookmarks/${heldId}/delete`, confirmed);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "<title>Deleted “Seeded” - Saved links - Haystack</title>",
    );
    expect(await heldRow()).toBeNull();
  });
});
