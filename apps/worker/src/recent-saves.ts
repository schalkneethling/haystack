// The recent saves list at `/` (plan, Phase 4). Milestone 3 replaces it with the search page.
import { isHttpsUrl } from "@haystack/schemas";
import { and, count, desc, eq, gt, or } from "drizzle-orm";
import { ADDRESS_FORM_SCRIPT, addressFormCard } from "./address-form.ts";
import { DELETE_DIALOG_SCRIPT, deleteForm, savedDate } from "./bookmark-card.ts";
import { HELD_PATH } from "./bookmark-paths.ts";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { errorCode } from "./error-code.ts";
import { countBookmarksToReview, readReviewPolicy, type ReviewConfig } from "./held.ts";
import { html, type SafeHtml } from "./html.ts";
import { type Outcome, SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";

// Until search arrives, the list shows the newest links only.
export const RECENT_SAVES_LIMIT = 50;

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
  const description =
    save.description === null
      ? null
      : html`
        <p class="card-description">${withLineBreaks(save.description)}</p>`;
  // The date comes first, as the card shows it, so the reading order matches what is seen.
  return html`<li id="bookmark-${save.id}">
        <p class="card-date">${savedDate(save.createdAt)}</p>
        <h2 id="title-${save.id}">${savedLink(save.url, save.title)}</h2>
        <p class="address">${save.url}</p>${description}
        ${deleteForm(save.id)}
      </li>`;
}

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

/**
 * How many of the user's bookmarks wait on /held, or 0 when the configuration the state depends
 * on can't be read. /held throws for that, as the sweep does, because it can't tell which
 * bookmarks to show. The saved links page doesn't need the state to save or list links, so it
 * logs the error's code and goes on without the link.
 */
async function countToReview(db: Db, userId: string, config: ReviewConfig): Promise<number> {
  let policy;
  try {
    policy = readReviewPolicy(config);
  } catch (error) {
    console.error("Review count skipped:", errorCode(error));
    return 0;
  }
  return countBookmarksToReview(db, userId, policy);
}

// Shown only when there is something to review, before the notice and the list.
function reviewLink(count: number): SafeHtml | null {
  if (count === 0) {
    return null;
  }
  return html`
      <p class="callout"><a href="${HELD_PATH}">Review ${count} ${count === 1 ? "link" : "links"}</a> that Haystack held back or couldn't describe.</p>`;
}

export async function showRecentSaves(
  db: Db,
  userId: string,
  config: ReviewConfig,
  outcome: Outcome | null = null,
): Promise<Response> {
  // One extra row says whether there are more than the page shows.
  const listed = db
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
  const [rows, reviewCount] = await Promise.all([listed, countToReview(db, userId, config)]);
  const saves = rows.slice(0, RECENT_SAVES_LIMIT);
  const message = outcome === null ? null : html`<p>${outcome.message}</p>`;
  return htmlResponse(
    outcome === null ? "Saved links" : `${outcome.title} - Saved links`,
    // The address form comes first, above the heading, as the design shows it.
    html`${addressFormCard()}
      <h1 id="list-heading">Saved links</h1>
      <div id="list-status" class="status" role="status">${message}</div>${reviewLink(reviewCount)}
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
