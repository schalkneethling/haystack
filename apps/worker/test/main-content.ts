// The content of a rendered page's <main>, for comparing pages whose headers differ on purpose:
// a signed-in user's header has the navigation and Sign out, and a signed-out one's does not.

/** The markup inside <main>. Fails the test when the page has none. */
export function mainContent(markup: string): string {
  const content = /<main>([\s\S]*)<\/main>/.exec(markup)?.[1];
  if (content === undefined) {
    throw new Error("The page has no <main>");
  }
  return content;
}
