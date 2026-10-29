// Deleting a bookmark. See "Deleting bookmarks" in plans/haystack-v1-implementation-plan.md.
// Every lookup matches the bookmark's ID and the session's user together, and a miss is a 404
// either way, so a response never reveals that another user's bookmark exists.
import { and, eq } from "drizzle-orm";
import { bookmarkHost } from "./bookmark-card.ts";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import {
  bookmarkAction,
  HELD_PATH,
  RETURN_FIELD,
  SAVED_LINKS_PATH,
  SEARCH_PATH,
} from "./bookmark-paths.ts";
import type { SearchFlags } from "./flags.ts";
import { readReviewPolicy, type ReviewConfig, showHeld } from "./held.ts";
import { html, type SafeHtml } from "./html.ts";
import type { Outcome } from "./notices.ts";
import { htmlResponse } from "./page.ts";
import { notSavedPage } from "./pages.ts";
import { showRecentSaves } from "./recent-saves.ts";
import { showSearchPage } from "./search-page.ts";

/**
 * The pages a delete returns to: the saved links, /held from its own Delete buttons, or the
 * search page from a result's (#208).
 */
export type DeleteReturnPage = typeof SAVED_LINKS_PATH | typeof HELD_PATH | typeof SEARCH_PATH;

/**
 * The page the delete form names in RETURN_FIELD. Any value other than HELD_PATH and
 * SEARCH_PATH, and no value, returns to the saved links, so the field can't send anyone
 * elsewhere.
 */
export function deleteReturnPage(form: FormData | undefined): DeleteReturnPage {
  const named = form?.get(RETURN_FIELD);
  return named === HELD_PATH || named === SEARCH_PATH ? named : SAVED_LINKS_PATH;
}

// What the confirmation shows of the address. From /held it shows the host only, as the card
// does, because the rest of a Held link's address may be what makes it private. A Held link is
// never a search result (plan, Phase 11), so from the search page it shows the whole address,
// as from the saved links.
function addressLine(url: string, returnPage: DeleteReturnPage): SafeHtml {
  return returnPage === HELD_PATH
    ? html`<p><strong>Site:</strong> <span class="address">${bookmarkHost(url)}</span></p>`
    : html`<p><strong>Address:</strong> <span class="address">${url}</span></p>`;
}

interface KeepLink {
  readonly text: string;
  href(bookmarkId: string): string;
}

// Where "Keep it" goes back to: the bookmark's card on the saved links and on /held, and the
// search page itself, without results, because they exist only in the page that searched, and
// showing them again would mean searching again.
const KEEP_LINKS: Record<DeleteReturnPage, KeepLink> = {
  [SAVED_LINKS_PATH]: {
    text: "Keep it and go back to your saved links",
    href: (bookmarkId) => `${SAVED_LINKS_PATH}#bookmark-${bookmarkId}`,
  },
  [HELD_PATH]: {
    text: "Keep it and go back to the links to review",
    href: (bookmarkId) => `${HELD_PATH}#bookmark-${bookmarkId}`,
  },
  [SEARCH_PATH]: {
    text: "Keep it and go back to search",
    href: () => SEARCH_PATH,
  },
};

function confirmationPage(
  bookmarkId: string,
  title: string,
  url: string,
  returnPage: DeleteReturnPage,
): Response {
  // The confirmation passes the return page on, so confirming returns where the delete started.
  const returnField =
    returnPage === SAVED_LINKS_PATH
      ? null
      : html`
        <input type="hidden" name="${RETURN_FIELD}" value="${returnPage}">`;
  const keep = KEEP_LINKS[returnPage];
  return htmlResponse(
    "Delete this link?",
    html`<h1>Delete this link?</h1>
      <p><strong>Title:</strong> ${title}</p>
      ${addressLine(url, returnPage)}
      <p>Deleting is permanent. You can save the link again later.</p>
      <form method="post" action="${bookmarkAction(bookmarkId, "delete")}">
        <input type="hidden" name="confirm" value="yes">${returnField}
        <button class="button button-danger" type="submit">Delete</button>
      </form>
      <p><a href="${keep.href(bookmarkId)}">${keep.text}</a></p>`,
    200,
    { signedIn: true },
  );
}

/** The request's form, or undefined when its body is not one. */
export async function readForm(request: Request): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}

/**
 * POST /bookmarks/:id/delete. Without `confirm=yes`, it shows the confirmation page; a Delete
 * button leads there when the dialog script doesn't run. With it, it deletes the bookmark and
 * shows the page the delete started from, the saved links, /held or the search page, with a
 * message saying what was deleted. A body that is not a form is never confirmed, so nothing is
 * deleted without the confirmation field. `search` reads the search page's switch, which only a
 * delete that returns to the search page reads.
 */
export async function deleteBookmark(
  request: Request,
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
  search: () => Promise<SearchFlags>,
): Promise<Response> {
  const form = await readForm(request);
  const returnPage = deleteReturnPage(form);
  const owned = and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId));
  if (form?.get("confirm") !== "yes") {
    const bookmark = await db
      .select({ title: bookmarks.title, url: bookmarks.url })
      .from(bookmarks)
      .where(owned)
      .get();
    return bookmark === undefined
      ? notSavedPage()
      : confirmationPage(bookmarkId, bookmark.title, bookmark.url, returnPage);
  }
  // /held can't be shown when the policy can't be read, so a delete that returns there reads it
  // first: a configuration error then answers 500 with nothing deleted, rather than after the
  // delete. A delete that returns to the saved links doesn't need it, and is unchanged. The
  // search switch never throws (flags.ts), so it is read after the delete.
  const heldPolicy = returnPage === HELD_PATH ? readReviewPolicy(config) : undefined;
  const deleted = await db
    .delete(bookmarks)
    .where(owned)
    .returning({ title: bookmarks.title })
    .get();
  if (deleted === undefined) {
    return notSavedPage();
  }
  const outcome: Outcome = {
    title: `Deleted “${deleted.title}”`,
    message: `Deleted “${deleted.title}”.`,
  };
  if (heldPolicy !== undefined) {
    return showHeld(db, userId, heldPolicy, outcome);
  }
  // The search page without results, as "Keep it" shows it. While search is switched off, `/`
  // is not the search page (#235), so the delete returns to the saved links instead.
  if (returnPage === SEARCH_PATH && (await search()).enabled) {
    return showSearchPage(outcome);
  }
  return showRecentSaves(db, userId, config, outcome);
}
