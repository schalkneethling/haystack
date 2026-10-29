// A bookmark's card, which the saved links page and the search page's results share (design
// review), and the parts of it that the review page at /held shares too: the date it was saved,
// its host, and its Delete button, which the dialog script enhances.
import { isHttpsUrl } from "@haystack/schemas";
import { bookmarkAction, type HELD_PATH, RETURN_FIELD, SEARCH_PATH } from "./bookmark-paths.ts";
import { html, type SafeHtml } from "./html.ts";

/**
 * The script that confirms a delete in a dialog and deletes in place, on every page with Delete
 * buttons. It finds each button's form by `data-delete-form` when the form is submitted, so it
 * leaves a page's other forms, such as Release on /held, alone, and handles forms added after
 * the page loaded, such as the search results' (#208). It reveals the page's empty state after
 * the last item. The search page loads it through search.js, which imports it.
 */
export const DELETE_DIALOG_SCRIPT = "/assets/delete-dialog.js";

// Dates are shown in UTC: the server does not know the reader's time zone. search.js repeats this
// formatter (SAVED_DATE there) for the search results' cards, which it fills in the browser.
const SAVED_DATE = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

/** "Saved" and the date, for the first line of a card. */
export function savedDate(createdAt: number): SafeHtml {
  const saved = new Date(createdAt);
  return html`Saved <time datetime="${saved.toISOString()}">${SAVED_DATE.format(saved)}</time>`;
}

/**
 * The host of a bookmark's address, which /held and its delete confirmation show instead of the
 * whole address, because the rest of a Held link's address may be what makes it private.
 */
export function bookmarkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // POST /save stores only URLs that parse, so only a change made by hand gets here.
    return "an address Haystack can't read";
  }
}

/**
 * The bookmark's Delete button, in a form that posts to the delete endpoint. Its name is "Delete"
 * followed by the title, so a list of them is told apart, which needs the card's title heading
 * to have the id `title-<bookmark id>`. From /held and from the search page, the form says so
 * (`returnTo`), and the delete returns there (#208).
 */
export function deleteForm(
  bookmarkId: string,
  returnTo?: typeof HELD_PATH | typeof SEARCH_PATH,
): SafeHtml {
  const returnField =
    returnTo === undefined
      ? null
      : html`
          <input type="hidden" name="${RETURN_FIELD}" value="${returnTo}">`;
  return html`<form method="post" action="${bookmarkAction(bookmarkId, "delete")}" data-delete-form>${returnField}
          <button class="button button-small button-danger-outline" type="submit" id="delete-${bookmarkId}" aria-labelledby="delete-${bookmarkId} title-${bookmarkId}">Delete</button>
        </form>`;
}

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

/** What a bookmark's card shows. */
export interface CardBookmark {
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

/**
 * A bookmark's card: the date it was saved, the title as a heading that wraps the link, the
 * address, the description, and Delete. The date comes first, as the card shows it, so the
 * reading order matches what is seen. An optional part starts with its own line break and sits at
 * the end of the line before it, so leaving it out leaves no blank line in the page.
 *
 * The search page has the same card in a template (`bookmarkCardTemplate`), which search.js fills
 * for each result, so a change here changes both pages. search.js finds the parts by their
 * elements and classes, so a change to those changes it too.
 */
export function bookmarkCard(
  bookmark: CardBookmark,
  returnTo?: typeof HELD_PATH | typeof SEARCH_PATH,
): SafeHtml {
  const description =
    bookmark.description === null
      ? null
      : html`
        <p class="card-description">${withLineBreaks(bookmark.description)}</p>`;
  return html`<li id="bookmark-${bookmark.id}">
        <p class="card-date">${savedDate(bookmark.createdAt)}</p>
        <h2 id="title-${bookmark.id}">${savedLink(bookmark.url, bookmark.title)}</h2>
        <p class="address">${bookmark.url}</p>${description}
        ${deleteForm(bookmark.id, returnTo)}
      </li>`;
}

/** The ID of the search page's card template, which search.js clones for each result. */
export const CARD_TEMPLATE_ID = "bookmark-card-template";

// The bookmark the template's card is built from. Every value is replaced in each clone. The
// address is https and the description is present, so the template has every part a card can
// have: search.js removes the link or the description when a result has none. The text is not
// empty, because the markup checks read a template's content too, and an empty heading or link
// would fail them.
const TEMPLATE_BOOKMARK: CardBookmark = {
  id: "template",
  url: "https://example.com/",
  title: "Title",
  description: "Description",
  createdAt: 0,
};

/**
 * The search page's card, as a `<template>`, whose content the browser parses but never shows,
 * so search.js can build each result from the same markup as a saved link's card, and fill it
 * with `textContent` and attributes, never with markup. Its Delete form returns to the search
 * page.
 */
export function bookmarkCardTemplate(): SafeHtml {
  return html`<template id="${CARD_TEMPLATE_ID}">${bookmarkCard(TEMPLATE_BOOKMARK, SEARCH_PATH)}</template>`;
}
