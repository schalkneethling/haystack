// The privacy policy, which the Chrome Web Store listing links to (#116). The store's reviewers
// can't sign in, so the entry point serves it without a session, with the signed-out header.
//
// It describes the code as it is, so a change to what the extension reads, what the Worker
// stores, or which service receives bookmark data has to change this page too. Each statement
// comes from the code or from "Q7" in plans/haystack-v1-implementation-plan.md, which records
// each service's terms as they were read.
import { SESSION_LIFETIME_MS } from "./auth/session-token.ts";
import { html } from "./html.ts";
import { htmlResponse } from "./page.ts";

export const PRIVACY_PATH = "/privacy";

/** The day the policy last changed, as `<time>` gives it. Change it with the text. */
const LAST_UPDATED = { iso: "2026-11-13", text: "13 November 2026" } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a sign-in lasts, and the last part of it in which using Haystack renews it. */
export const SESSION_DAYS = SESSION_LIFETIME_MS / DAY_MS;
// shouldExtendSession in auth/session-token.ts renews a session used in its second half.
export const RENEWAL_DAYS = SESSION_DAYS / 2;

const REPOSITORY = "https://github.com/schalkneethling/haystack";

export function privacyPage(): Response {
  return htmlResponse(
    "Privacy policy",
    html`<h1>Privacy policy</h1>
      <p>Last updated <time datetime="${LAST_UPDATED.iso}">${LAST_UPDATED.text}</time>.</p>
      <p>
        Haystack is a personal bookmarking app that Schalk Neethling runs for his own use. Only
        the Google accounts he has invited can sign in. This page says what Haystack and its
        browser extension collect, where it goes, and how long it stays.
      </p>

      <h2>The browser extension</h2>
      <p>
        The extension does something only when you click its toolbar button. It then reads, from
        the tab you are on: the page's address, its title, its description, its canonical link,
        and its Open Graph title, description and site name. It reads no other tab, nothing in
        the background, and not your browsing history, and it stores nothing.
      </p>
      <p>
        It sends what it read to Haystack and nowhere else, by opening Haystack's save form in a
        new tab with those details in the form's address. An address that looks as if it holds
        a secret, such as a sign-in or password reset link, is refused, and never leaves your
        browser.
      </p>
      <p>
        The link is saved only when you choose Save on that form, but Haystack receives the
        details as soon as the form opens. It then asks TypeSafe, described below, whether the
        link might be private, so that the form can warn you. If you aren't signed in, Haystack
        keeps the details while you sign in, so that the form can open afterwards, and deletes
        them within about an hour.
      </p>

      <h2>What Haystack stores</h2>
      <ul>
        <li>
          <strong>Your account:</strong> the ID, email address and name your Google account
          gives Haystack when you sign in. Signing in goes through Google, so Google knows when
          you sign in to Haystack.
        </li>
        <li>
          <strong>Your sign-in:</strong> a cookie that keeps you signed in for ${SESSION_DAYS}
          days. Using Haystack in the last ${RENEWAL_DAYS} of those days renews it for another
          ${SESSION_DAYS}. It is the only cookie Haystack sets, apart from one that lasts 10
          minutes while you sign in.
        </li>
        <li>
          <strong>Each link you save:</strong> the details listed above, and the description
          Haystack writes for it so that you can find it again. When you save a link by pasting
          its address into Haystack instead, Haystack requests the page once to read the same
          details.
        </li>
        <li>
          <strong>Your searches:</strong> what you searched for, whether you typed or spoke it,
          how each saved link was judged against it, which links were shown, and which one you
          followed.
        </li>
      </ul>
      <p>
        Haystack shows no ads and uses no third-party analytics or trackers. It doesn't sell your
        data, and shares it with no one other than the services below.
      </p>

      <h2>Who else receives it</h2>
      <p>
        Haystack runs on Cloudflare, which hosts the app and its database. To describe and
        search your links, it sends some of their details to these services. A link that
        Haystack judges might be private is held, and none of its details go to Anthropic,
        GitHub or TypeSafe's second question below until you confirm that it isn't private.
      </p>
      <ul>
        <li>
          <strong>Anthropic,</strong> through Cloudflare's AI Gateway: each saved link's details,
          so that its model, Claude, can write the link's description. Anthropic does not train
          its models on them. It deletes them within 30 days, except content its safety systems
          flag, which it can keep for up to 2 years. The gateway logs that a request was made,
          but not what it held. See
          <a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data">how long Anthropic keeps data</a>.
        </li>
        <li>
          <strong>TypeSafe,</strong> whose model checks and ranks links. To judge whether a link
          might be private, it gets the page's title and a description of the address with
          anything that could be a secret removed, never the address itself. Once a link is
          saved, it gets the link's details, address included, to tell what kind of page it is.
          For each search, it gets what you searched for, with the titles and the descriptions
          Haystack wrote for the links it is compared with. TypeSafe does not train its models
          on them, and its policy gives no fixed period for keeping them. See
          <a href="https://typesafe.ai/privacy">TypeSafe's privacy policy</a>.
        </li>
        <li>
          <strong>GitHub,</strong> for a link to a GitHub repository, or to a page inside one:
          the repository's owner and name, to read its description and README. GitHub's privacy
          statement allows it to use data about requests, such as when they were made, to train
          its models. See
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub's privacy statement</a>.
        </li>
      </ul>
      <p>
        If you search by voice, your browser turns your speech into text. In some browsers,
        including Chrome, that sends a recording to the browser maker's servers. Haystack
        receives only the text.
      </p>

      <h2>Deleting what you saved</h2>
      <p>
        You can delete any saved link. That removes it from Haystack at once, with its
        description and its place in past search results. It doesn't recall what was already
        sent to the services above, which keep it as their own policies say.
      </p>
      <p>
        Your past searches themselves are kept, and Haystack has no way to delete them yet.
        Haystack's database can be restored to how it was at any time in the last 30 days, and
        Schalk keeps weekly copies of it with no set end date, so a deleted link can remain in
        those backups.
      </p>

      <h2>Questions and changes</h2>
      <p>
        Haystack's code is public at
        <a href="${REPOSITORY}">github.com/schalkneethling/haystack</a>, where you can ask a
        question by opening an issue. Issues are public, so don't include links you have
        saved. When this policy changes, this page changes with it, and so does the date at the
        top.
      </p>`,
    200,
    { signedIn: false },
  );
}
