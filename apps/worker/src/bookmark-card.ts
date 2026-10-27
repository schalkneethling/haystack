// The parts of a bookmark's card that the saved links page and the review page at /held share:
// the date it was saved, and its Delete button, which the dialog script enhances.
import { bookmarkAction, HELD_PATH, RETURN_FIELD } from "./bookmark-paths.ts";
import { html, type SafeHtml } from "./html.ts";

/**
 * The script that confirms a delete in a dialog and deletes in place, on every page with Delete
 * buttons. It finds each button's form by `data-delete-form`, so it leaves a page's other forms,
 * such as Release on /held, alone. It reveals the page's empty state after the last item.
 */
export const DELETE_DIALOG_SCRIPT = "/assets/delete-dialog.js";

// Dates are shown in UTC: the server does not know the reader's time zone.
const SAVED_DATE = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

/** "Saved" and the date, for the first line of a card. */
export function savedDate(createdAt: number): SafeHtml {
  const saved = new Date(createdAt);
  return html`Saved <time datetime="${saved.toISOString()}">${SAVED_DATE.format(saved)}</time>`;
}

/**
 * The bookmark's Delete button, in a form that posts to the delete endpoint. Its name is "Delete"
 * followed by the title, so a list of them is told apart, which needs the card's title heading
 * to have the id `title-<bookmark id>`. From /held, the form says so (`returnTo`), and the delete
 * returns there.
 */
export function deleteForm(bookmarkId: string, returnTo?: typeof HELD_PATH): SafeHtml {
  const returnField =
    returnTo === undefined
      ? null
      : html`
          <input type="hidden" name="${RETURN_FIELD}" value="${returnTo}">`;
  return html`<form method="post" action="${bookmarkAction(bookmarkId, "delete")}" data-delete-form>${returnField}
          <button class="button button-small button-danger-outline" type="submit" id="delete-${bookmarkId}" aria-labelledby="delete-${bookmarkId} title-${bookmarkId}">Delete</button>
        </form>`;
}
