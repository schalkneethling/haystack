// Deleting a bookmark. See "Deleting bookmarks" in plans/haystack-v1-implementation-plan.md.
// Every lookup matches the bookmark's ID and the session's user together, and a miss is a 404
// either way, so a response never reveals that another user's bookmark exists.
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { html } from "./html.ts";
import { htmlResponse } from "./page.ts";
import { deleteAction } from "./bookmark-paths.ts";
import { showRecentSaves } from "./recent-saves.ts";

function confirmationPage(bookmarkId: string, title: string, url: string): Response {
  return htmlResponse(
    "Delete this link?",
    html`<h1>Delete this link?</h1>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>Address:</strong> ${url}</p>
      <p>Deleting is permanent. You can save the link again later.</p>
      <form method="post" action="${deleteAction(bookmarkId)}">
        <input type="hidden" name="confirm" value="yes">
        <button type="submit">Delete</button>
      </form>
      <p><a href="/#bookmark-${bookmarkId}">Keep it and go back to your saved links</a></p>`,
    200,
  );
}

// The same page for a bookmark that does not exist, was already deleted (a reload after
// deleting posts again), or belongs to someone else, so it reveals nothing.
function notSavedPage(): Response {
  return htmlResponse(
    "Link not found",
    html`<h1>This link isn't in your saved links</h1>
      <p>It may have been deleted already.</p>
      <p><a href="/">Go to your saved links</a></p>`,
    404,
  );
}

async function isConfirmed(request: Request): Promise<boolean> {
  try {
    return (await request.formData()).get("confirm") === "yes";
  } catch {
    // Not a form submission. Nothing is deleted without the confirmation field.
    return false;
  }
}

/**
 * POST /bookmarks/:id/delete. Without `confirm=yes`, it shows the confirmation page; the
 * button on the list leads there when JavaScript is off. With it, it deletes the bookmark and
 * shows the list with a message saying what was deleted.
 */
export async function deleteBookmark(
  request: Request,
  db: Db,
  userId: string,
  bookmarkId: string,
): Promise<Response> {
  const owned = and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId));
  if (!(await isConfirmed(request))) {
    const bookmark = await db
      .select({ title: bookmarks.title, url: bookmarks.url })
      .from(bookmarks)
      .where(owned)
      .get();
    return bookmark === undefined
      ? notSavedPage()
      : confirmationPage(bookmarkId, bookmark.title, bookmark.url);
  }
  const deleted = await db
    .delete(bookmarks)
    .where(owned)
    .returning({ title: bookmarks.title })
    .get();
  if (deleted === undefined) {
    return notSavedPage();
  }
  // In the title too: a screen reader announces the title when the page loads, but not a
  // status message that arrives with it.
  return showRecentSaves(db, userId, {
    title: `Deleted “${deleted.title}”`,
    message: html`<p>Deleted “${deleted.title}”.</p>`,
  });
}
