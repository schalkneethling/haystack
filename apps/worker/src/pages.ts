// Pages that every phase shares: sign-in outcomes and "not found". None of them interpolates
// user data; later pages use the same `html` helper for anything that does.
import { html } from "./html.ts";
import { htmlResponse } from "./page.ts";

const signInAgain = html`<p><a href="/auth/sign-in">Sign in again</a></p>`;

export function signInLinkExpiredPage(): Response {
  return htmlResponse(
    "Sign-in link expired",
    html`<h1>This sign-in link has expired</h1>
      <p>It was already used, or it is more than 10 minutes old.</p>
      ${signInAgain}`,
    400,
  );
}

export function signInFailedPage(): Response {
  return htmlResponse(
    "Sign-in failed",
    html`<h1>Sign-in failed</h1>
      <p>Google could not confirm your sign-in.</p>
      ${signInAgain}`,
    400,
  );
}

export function accountNotAllowedPage(): Response {
  return htmlResponse(
    "Account not allowed",
    html`<h1>This Google account is not allowed to use Haystack</h1>
      <p>Haystack is invite-only. Sign in with an account that has access.</p>
      ${signInAgain}`,
    403,
  );
}

export function signedOutPage(): Response {
  return htmlResponse(
    "Signed out",
    html`<h1>You are signed out of Haystack</h1>
      ${signInAgain}`,
    200,
  );
}

export function notFoundPage(): Response {
  return htmlResponse(
    "Page not found",
    html`<h1>Page not found</h1>
      <p><a href="/">Go to Haystack</a></p>`,
    404,
  );
}
