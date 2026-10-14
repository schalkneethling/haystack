// Paths for a bookmark's own routes, shared by the pages that link to them and the router.
const DELETE_PATH = /^\/bookmarks\/([^/]+)\/delete$/;

export function deleteAction(bookmarkId: string): string {
  return `/bookmarks/${encodeURIComponent(bookmarkId)}/delete`;
}

/** The bookmark ID in a delete path, or undefined if the path is not one. */
export function deletePathId(path: string): string | undefined {
  const encoded = DELETE_PATH.exec(path)?.[1];
  if (encoded === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
