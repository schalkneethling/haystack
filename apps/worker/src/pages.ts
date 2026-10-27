// Pages that every phase shares: sign-in outcomes and "not found". None of them interpolates
// user data; later pages use the same `html` helper for anything that does. The sign-in outcomes
// are shown to someone who is not signed in, so their header has the wordmark only.
import { AUTH_FLOW_LIFETIME_MS } from "./auth/auth-flows.ts";
import { html } from "./html.ts";
import { htmlResponse } from "./page.ts";

const SIGNED_OUT = { signedIn: false } as const;

const signInAgain = html`<p><a href="/auth/sign-in">Sign in again</a></p>`;

export function signInLinkExpiredPage(): Response {
  return htmlResponse(
    "Sign-in link expired",
    html`<h1>This sign-in link has expired</h1>
      <p>
        A sign-in link works once, for ${AUTH_FLOW_LIFETIME_MS / 60_000} minutes, and only in the
        browser where you started signing in.
      </p>
      ${signInAgain}`,
    400,
    SIGNED_OUT,
  );
}

export function signInFailedPage(): Response {
  return htmlResponse(
    "Sign-in failed",
    html`<h1>Sign-in failed</h1>
      <p>Google could not confirm your sign-in.</p>
      ${signInAgain}`,
    400,
    SIGNED_OUT,
  );
}

export function accountNotAllowedPage(): Response {
  return htmlResponse(
    "Account not allowed",
    html`<h1>This Google account is not allowed to use Haystack</h1>
      <p>Haystack is invite-only. Sign in with an account that has access.</p>
      <p><a href="/auth/sign-in?select_account">Sign in with a different account</a></p>`,
    403,
    SIGNED_OUT,
  );
}

export function signedOutPage(): Response {
  return htmlResponse(
    "Signed out",
    html`<h1>You are signed out of Haystack</h1>
      ${signInAgain}`,
    200,
    SIGNED_OUT,
  );
}

/**
 * `signedIn` is whether the router knows the visitor is signed in. Only then does the header
 * show the navigation and Sign out.
 */
export function notFoundPage(signedIn: boolean): Response {
  return htmlResponse(
    "Page not found",
    html`<h1>Page not found</h1>
      <p><a href="/">Go to Haystack</a></p>`,
    404,
    { signedIn },
  );
}

/**
 * The 404 for a bookmark's route (delete, release or retry) whose bookmark doesn't exist, was
 * already deleted (a reload after deleting posts again), or belongs to someone else. It is the
 * same page whichever it is, so it reveals nothing.
 */
export function notSavedPage(): Response {
  return htmlResponse(
    "Link not found",
    html`<h1>This link isn't in your saved links</h1>
      <p>It may have been deleted already.</p>
      <p><a href="/">Go to your saved links</a></p>`,
    404,
    { signedIn: true },
  );
}
