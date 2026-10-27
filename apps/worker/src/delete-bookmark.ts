// Deleting a bookmark. See "Deleting bookmarks" in plans/haystack-v1-implementation-plan.md.
// Every lookup matches the bookmark's ID and the session's user together, and a miss is a 404
// either way, so a response never reveals that another user's bookmark exists.
import { and, eq } from "drizzle-orm";
import { bookmarkHost } from "./bookmark-card.ts";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { bookmarkAction, HELD_PATH, RETURN_FIELD } from "./bookmark-paths.ts";
import { readReviewPolicy, type ReviewConfig, showHeld } from "./held.ts";
import { html, type SafeHtml } from "./html.ts";
import type { Outcome } from "./notices.ts";
import { htmlResponse } from "./page.ts";
import { notSavedPage } from "./pages.ts";
import { showRecentSaves } from "./recent-saves.ts";

/** The pages a delete returns to: the saved links, or /held from its own Delete buttons. */
export type DeleteReturnPage = "/" | typeof HELD_PATH;

/**
 * The page the delete form names in RETURN_FIELD. Any value other than HELD_PATH, and no value,
 * returns to the saved links, so the field can't send anyone elsewhere.
 */
export function deleteReturnPage(form: FormData | undefined): DeleteReturnPage {
  return form?.get(RETURN_FIELD) === HELD_PATH ? HELD_PATH : "/";
}

// What the confirmation shows of the address. From /held it shows the host only, as the card
// does, because the rest of a Held link's address may be what makes it private.
function addressLine(url: string, returnPage: DeleteReturnPage): SafeHtml {
  return returnPage === HELD_PATH
    ? html`<p><strong>Site:</strong> <span class="address">${bookmarkHost(url)}</span></p>`
    : html`<p><strong>Address:</strong> <span class="address">${url}</span></p>`;
}

// Where "Keep it" goes back to, at the bookmark's card.
const KEEP_LINKS: Record<DeleteReturnPage, string> = {
  "/": "Keep it and go back to your saved links",
  [HELD_PATH]: "Keep it and go back to the links to review",
};

function confirmationPage(
  bookmarkId: string,
  title: string,
  url: string,
  returnPage: DeleteReturnPage,
): Response {
  // The confirmation passes the return page on, so confirming returns where the delete started.
  const returnField =
    returnPage === HELD_PATH
      ? html`
        <input type="hidden" name="${RETURN_FIELD}" value="${HELD_PATH}">`
      : null;
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
      <p><a href="${returnPage}#bookmark-${bookmarkId}">${KEEP_LINKS[returnPage]}</a></p>`,
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
 * POST /bookmarks/:id/delete. Without `confirm=yes`, it shows the confirmation page; the
 * button on the list leads there when JavaScript is off. With it, it deletes the bookmark and
 * shows the page the delete started from, the saved links or /held, with a message saying what
 * was deleted. A body that is not a form is never confirmed, so nothing is deleted without the
 * confirmation field.
 */
export async function deleteBookmark(
  request: Request,
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
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
  // delete. A delete that returns to the saved links doesn't need it, and is unchanged.
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
  return heldPolicy === undefined
    ? showRecentSaves(db, userId, config, outcome)
    : showHeld(db, userId, heldPolicy, outcome);
}
