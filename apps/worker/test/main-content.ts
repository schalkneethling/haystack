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

/**
 * A signed-in page's <main> as a user who is not signed in gets it. The address form asks for
 * GET /save before sign-in, and posts to /save/address after it (address-form.ts says why).
 * Nothing else differs.
 */
export function signedOutMainContent(signedInMarkup: string): string {
  return mainContent(signedInMarkup).replace(
    'method="post" action="/save/address"',
    'method="get" action="/save"',
  );
}
