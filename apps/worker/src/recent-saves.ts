// The recent saves list at `/` (plan, Phase 4). Milestone 3 replaces it with the search page.
import { isHttpsUrl } from "@haystack/schemas";
import { and, count, desc, eq, gt, or } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { html, type SafeHtml } from "./html.ts";
import { SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";

// Until search arrives, the list shows the newest links only.
export const RECENT_SAVES_LIMIT = 50;

// Dates are shown in UTC: the server does not know the reader's time zone.
const SAVED_DATE = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

/**
 * Links `content` to a saved address. Escaping does not make a URL safe, so only an https URL
 * becomes a link; anything else, such as a row saved before only https was accepted, is shown
 * without one. `noreferrer` keeps the saved site from learning where the visit came from.
 */
export function savedLink(url: string, content: string): SafeHtml {
  return isHttpsUrl(url)
    ? html`<a href="${url}" rel="noreferrer">${content}</a>`
    : html`${content}`;
}

interface RecentSave {
  id: string;
  url: string;
  title: string;
  description: string | null;
  createdAt: number;
}

// An optional part starts with its own line break and sits at the end of the line before it,
// so leaving it out leaves no blank line in the page.
// Line breaks typed into the description are kept as <br>.
function withLineBreaks(text: string): SafeHtml {
  return html`${text.split("\n").map((line, index) => (index === 0 ? line : html`<br>${line}`))}`;
}

function item(save: RecentSave): SafeHtml {
  const saved = new Date(save.createdAt);
  const description =
    save.description === null
      ? null
      : html`
        <p>${withLineBreaks(save.description)}</p>`;
  return html`<li id="bookmark-${save.id}">
        <h2>${savedLink(save.url, save.title)}</h2>
        <p>${save.url}</p>${description}
        <p>Saved <time datetime="${saved.toISOString()}">${SAVED_DATE.format(saved)}</time></p>
      </li>`;
}

function list(saves: readonly RecentSave[], more: boolean): SafeHtml {
  if (saves.length === 0) {
    return html`<p>
        You haven't saved any links yet. Links you save appear here, newest first.
      </p>`;
  }
  // Before the list, so it is read first. It ends with the line break the list needs.
  const limitNote = more
    ? html`<p>Showing your ${RECENT_SAVES_LIMIT} most recent links.</p>
      `
    : null;
  return html`${limitNote}<ol>
        ${saves.map(item)}
      </ol>`;
}

/** Where a bookmark sits in the list's order. */
export interface ListPosition {
  id: string;
  createdAt: number;
}

/** Whether the bookmark is among the ones the list shows, in the list's order. */
export async function isInRecentSaves(
  db: Db,
  userId: string,
  { id, createdAt }: ListPosition,
): Promise<boolean> {
  const newer = await db
    .select({ n: count() })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        or(
          gt(bookmarks.createdAt, createdAt),
          and(eq(bookmarks.createdAt, createdAt), gt(bookmarks.id, id)),
        ),
      ),
    )
    .get();
  return (newer?.n ?? 0) < RECENT_SAVES_LIMIT;
}

export async function showRecentSaves(db: Db, userId: string): Promise<Response> {
  // One extra row says whether there are more than the page shows.
  const rows = await db
    .select({
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      description: bookmarks.description,
      createdAt: bookmarks.createdAt,
    })
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .limit(RECENT_SAVES_LIMIT + 1);
  const saves = rows.slice(0, RECENT_SAVES_LIMIT);
  return htmlResponse(
    "Saved links",
    html`<h1>Saved links</h1>
      ${SENSITIVE_NOTICE}
      ${list(saves, rows.length > RECENT_SAVES_LIMIT)}`,
    200,
  );
}
