// Paths for the pages that list bookmarks and for a bookmark's own routes, shared by the pages
// that link to them and the router. Each bookmark route is a POST: delete from any page that
// lists the bookmark, and release and retry from /held.
const ACTION_PATH = /^\/bookmarks\/([^/]+)\/(delete|release|retry)$/;

/**
 * The saved links page, which lists the user's most recent bookmarks (recent-saves.ts). It moved
 * from `/` so that the search page can take the home page (#205). The path names the page as its
 * heading and the navigation do.
 */
export const SAVED_LINKS_PATH = "/saved-links";

/** The review page for the user's Held and Failed bookmarks (held.ts). */
export const HELD_PATH = "/held";

/**
 * The delete form's field that names the page to return to. Only /held's forms send it, with
 * HELD_PATH. Without it, a delete returns to the saved links.
 */
export const RETURN_FIELD = "return_to";

/** What a bookmark's route does to it. */
export type BookmarkAction = "delete" | "release" | "retry";

export function bookmarkAction(bookmarkId: string, action: BookmarkAction): string {
  return `/bookmarks/${encodeURIComponent(bookmarkId)}/${action}`;
}

/** A bookmark's route, read from its path. */
export interface BookmarkRoute {
  bookmarkId: string;
  action: BookmarkAction;
}

/** The bookmark ID and the action in a bookmark's path, or undefined if the path is not one. */
export function bookmarkActionPath(path: string): BookmarkRoute | undefined {
  const match = ACTION_PATH.exec(path);
  const encoded = match?.[1];
  const action = match?.[2] as BookmarkAction | undefined;
  if (encoded === undefined || action === undefined) {
    return undefined;
  }
  try {
    return { bookmarkId: decodeURIComponent(encoded), action };
  } catch {
    return undefined;
  }
}
