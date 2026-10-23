// The recent saves list at `/` (plan, Phase 4). Milestone 3 replaces it with the search page.
import { isHttpsUrl } from "@haystack/schemas";
import { and, count, desc, eq, gt, or } from "drizzle-orm";
import { ADDRESS_FORM_SCRIPT, addressFormCard } from "./address-form.ts";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { html, type SafeHtml } from "./html.ts";
import { deleteAction } from "./bookmark-paths.ts";
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

// Line breaks typed into the description are kept as <br>.
function withLineBreaks(text: string): SafeHtml {
  return html`${text.split("\n").map((line, index) => (index === 0 ? line : html`<br>${line}`))}`;
}

// An optional part starts with its own line break and sits at the end of the line before it,
// so leaving it out leaves no blank line in the page.
function item(save: RecentSave): SafeHtml {
  const saved = new Date(save.createdAt);
  const description =
    save.description === null
      ? null
      : html`
        <p class="card-description">${withLineBreaks(save.description)}</p>`;
  // The date comes first, as the card shows it, so the reading order matches what is seen.
  // The button's name is "Delete" followed by the title, so a list of them is told apart.
  return html`<li id="bookmark-${save.id}">
        <p class="card-date">Saved <time datetime="${saved.toISOString()}">${SAVED_DATE.format(saved)}</time></p>
        <h2 id="title-${save.id}">${savedLink(save.url, save.title)}</h2>
        <p class="address">${save.url}</p>${description}
        <form method="post" action="${deleteAction(save.id)}">
          <button class="button button-small button-danger-outline" type="submit" id="delete-${save.id}" aria-labelledby="delete-${save.id} title-${save.id}">Delete</button>
        </form>
      </li>`;
}

// The dialog script deletes items in place, so it reveals the empty state after the last one.
const DELETE_DIALOG_SCRIPT = "/assets/delete-dialog.js";

function list(saves: readonly RecentSave[], more: boolean): SafeHtml {
  // With older links beyond the limit, an emptied list does not mean nothing is saved.
  const emptyText = more
    ? html`You deleted every link shown here. Reload the page to see your older links.`
    : html`You haven't saved any links yet. Links you save appear here, newest first.`;
  const emptyState = html`<p id="empty-state" class="empty-state"${saves.length === 0 ? null : html` hidden`}>
        ${emptyText}
      </p>`;
  if (saves.length === 0) {
    return emptyState;
  }
  // Before the list, so it is read first. It ends with the line break the list needs.
  const limitNote = more
    ? html`<p>This list shows only your ${RECENT_SAVES_LIMIT} most recent links.</p>
      `
    : null;
  return html`${limitNote}<ol id="recent-saves" class="cards">
        ${saves.map(item)}
      </ol>
      ${emptyState}`;
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

/** The result of an action, such as deleting a bookmark, shown on the list page. */
export interface Outcome {
  // Comes first in the page title.
  title: string;
  // Shown in the list's live region, which is on the page on every load, so the dialog
  // script can announce a deletion in it.
  message: SafeHtml;
}

export async function showRecentSaves(
  db: Db,
  userId: string,
  outcome: Outcome | null = null,
): Promise<Response> {
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
    outcome === null ? "Saved links" : `${outcome.title} - Saved links`,
    // The address form comes first, above the heading, as the design shows it.
    html`${addressFormCard()}
      <h1 id="list-heading">Saved links</h1>
      <div id="list-status" class="status" role="status">${outcome?.message}</div>
      ${SENSITIVE_NOTICE}
      ${list(saves, rows.length > RECENT_SAVES_LIMIT)}`,
    200,
    {
      signedIn: true,
      width: "wide",
      current: "saved-links",
      scripts: [DELETE_DIALOG_SCRIPT, ADDRESS_FORM_SCRIPT],
    },
  );
}
