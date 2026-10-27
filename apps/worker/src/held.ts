// The review page at /held (#129): the signed-in user's Held bookmarks, which wait for them to
// release or delete them, and their Failed bookmarks, which wait for them to retry or delete
// them. See "Reviewing Held bookmarks" and "Enrichment sweep" in
// plans/haystack-v1-implementation-plan.md.
//
// Each bookmark's state comes from the user's state input rows (state-inputs.ts), through
// collectStateInputs and deriveEnrichmentState, which the sweep's selection also derives its
// state with, so the page and the sweep can't disagree about which bookmarks are Held or Failed. Every lookup matches the bookmark's ID and the session's
// user together, and a miss gets the delete's 404 page, so no answer reveals that another user's
// bookmark exists.
//
// Release and Retry are ordinary forms that load the page again, with or without JavaScript,
// because each is one quick write. Delete is the delete endpoint's (delete-bookmark.ts), whose
// dialog script works here as on the saved links page.
import { and, eq, exists, sql } from "drizzle-orm";
import { bookmarkHost, DELETE_DIALOG_SCRIPT, deleteForm, savedDate } from "./bookmark-card.ts";
import { bookmarkAction, HELD_PATH } from "./bookmark-paths.ts";
import type { Db } from "./db/client.ts";
import { bookmarks, enrichmentFailures } from "./db/schema.ts";
import type { EnrichmentFailureReason, EnrichmentStep } from "./enrichment/enrich-bookmark.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "./enrichment/enrichment-schema.ts";
import {
  collectStateInputs,
  readEnrichmentStateInputs,
  selectStateInputRows,
} from "./enrichment/state-inputs.ts";
import {
  deriveEnrichmentState,
  type EnrichmentStateInputs,
  type EnrichmentStatePolicy,
  readSensitiveWarnThreshold,
  type SensitiveWarnThresholdConfig,
} from "./enrichment/state.ts";
import { html, type SafeHtml } from "./html.ts";
import type { Outcome } from "./notices.ts";
import { htmlResponse } from "./page.ts";
import { notSavedPage } from "./pages.ts";
import { readSweepAttemptLimit, type SweepAttemptLimitConfig } from "./scheduled.ts";

/** The configuration a bookmark's state depends on. `Env` has it, from `vars`. */
export type ReviewConfig = SensitiveWarnThresholdConfig & SweepAttemptLimitConfig;

/**
 * The policy the sweep derives the state with: the current schema version, the warning threshold
 * and the attempt limit. Throws for a threshold or an attempt limit that can't be read, as the
 * sweep does, because a guessed value would change which bookmarks are Held or Failed.
 */
export function readReviewPolicy(config: ReviewConfig): EnrichmentStatePolicy {
  return {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    sensitiveWarnThreshold: readSensitiveWarnThreshold(config),
    attemptLimit: readSweepAttemptLimit(config),
  };
}

/** The two kinds of bookmark that /held lists. */
type ReviewKind = "held" | "failed";

// The kind the bookmark is listed as, or undefined when it needs no review.
function reviewKind(
  inputs: EnrichmentStateInputs,
  policy: EnrichmentStatePolicy,
): ReviewKind | undefined {
  const state = deriveEnrichmentState(inputs, policy);
  return state === "held" || state === "failed" ? state : undefined;
}

/** How many of the user's bookmarks are Held or Failed, for the link on the saved links page. */
export async function countBookmarksToReview(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<number> {
  const inputs = await readEnrichmentStateInputs(db, userId, policy.schemaVersion);
  return inputs.filter((bookmark) => reviewKind(bookmark, policy) !== undefined).length;
}

/**
 * The plain words for what each step was doing, and for why it failed. They are chosen from the
 * fixed codes that `last_error` starts with (`<step>:<reason>`, enrich-bookmark.ts), so the page
 * never shows the stored text itself.
 */
const STEP_WORDS: Record<EnrichmentStep, string> = {
  sensitivity: "Checking whether the link is private",
  kind: "Working out what kind of link it is",
  llm: "Writing its description",
};

// `spend-limit` is an account's failure, which is never recorded against a bookmark (#127), but
// the type allows it, so it has words too.
const REASON_WORDS: Record<EnrichmentFailureReason, string> = {
  timeout: "the service took too long to answer",
  network: "Haystack couldn't reach the service",
  status: "the service answered with an error",
  "invalid-response": "Haystack couldn't read the service's answer",
  "invalid-output": "the description that came back wasn't in the shape Haystack needs",
  refused: "the service declined to answer",
  truncated: "the description that came back was cut off",
  "spend-limit": "Haystack's account reached its spending limit",
};

// For a record whose codes aren't in the lists, which only a change made by hand can store.
const UNKNOWN_FAILURE = "Haystack couldn't describe this link.";

function wordsFor<Code extends string>(
  words: Record<Code, string>,
  code: string | undefined,
): string | undefined {
  return code !== undefined && Object.hasOwn(words, code) ? words[code as Code] : undefined;
}

/** The last error as a sentence, for example "Writing its description failed, because …". */
export function failureInPlainWords(lastError: string | null): string {
  const [step, reason] = (lastError ?? "").split(":");
  const stepWords = wordsFor(STEP_WORDS, step);
  const reasonWords = wordsFor(REASON_WORDS, reason);
  if (stepWords === undefined || reasonWords === undefined) {
    return UNKNOWN_FAILURE;
  }
  return `${stepWords} failed, because ${reasonWords}.`;
}

interface ReviewItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  lastError: string | null;
}

// The two items share their start: the date, as on the saved links page, the title, which names
// each button, and the host.
function itemStart(item: ReviewItem): SafeHtml {
  return html`<p class="card-date">${savedDate(item.createdAt)}</p>
        <h3 id="title-${item.id}">${item.title}</h3>
        <p class="address">${bookmarkHost(item.url)}</p>`;
}

/** The checkbox's label, which a release without it quotes. */
const NOT_PRIVATE_LABEL = "This link does not give access to anything private";
const NOT_PRIVATE_FIELD = "not_private";

// The checkbox is required, so the browser asks for it before the form is sent, with or without
// JavaScript, and the server checks it again. It is described by the title, because every Held
// card's checkbox has the same label. The release form's box is left out of the layout
// (site.css), so the checkbox gets a row of its own above Release and Delete.
function heldItem(item: ReviewItem): SafeHtml {
  const checkboxId = `not-private-${item.id}`;
  return html`<li id="bookmark-${item.id}">
        ${itemStart(item)}
        <div class="card-actions">
          <form class="release-form" method="post" action="${bookmarkAction(item.id, "release")}">
            <div class="checkbox">
              <input type="checkbox" id="${checkboxId}" name="${NOT_PRIVATE_FIELD}" value="yes" required aria-describedby="title-${item.id}">
              <label for="${checkboxId}">${NOT_PRIVATE_LABEL}</label>
            </div>
            <button class="button button-small button-primary" type="submit" id="release-${item.id}" aria-labelledby="release-${item.id} title-${item.id}">Release</button>
          </form>
          ${deleteForm(item.id, HELD_PATH)}
        </div>
      </li>`;
}

function failedItem(item: ReviewItem): SafeHtml {
  return html`<li id="bookmark-${item.id}">
        ${itemStart(item)}
        <p class="card-error"><strong>Last error:</strong> ${failureInPlainWords(item.lastError)}</p>
        <div class="card-actions">
          <form method="post" action="${bookmarkAction(item.id, "retry")}">
            <button class="button button-small button-primary" type="submit" id="retry-${item.id}" aria-labelledby="retry-${item.id} title-${item.id}">Retry</button>
          </form>
          ${deleteForm(item.id, HELD_PATH)}
        </div>
      </li>`;
}

interface SectionContent {
  id: "held" | "failed";
  heading: string;
  intro: string;
  item: (item: ReviewItem) => SafeHtml;
}

const HELD_SECTION: SectionContent = {
  id: "held",
  heading: "Held back",
  intro:
    "These links look as if they might give access to something private, such as a private share or a sign-in link. Haystack sends nothing about them to the services that describe links until you release them.",
  item: heldItem,
};

const FAILED_SECTION: SectionContent = {
  id: "failed",
  heading: "Not described",
  intro:
    "Haystack tried to describe these links several times and stopped. Retry a link to have Haystack try again.",
  item: failedItem,
};

// A kind with nothing in it has no section, so the page shows only what needs the user. The
// dialog script removes a section when its last item is deleted, for the same reason.
function section(content: SectionContent, items: readonly ReviewItem[]): SafeHtml | null {
  if (items.length === 0) {
    return null;
  }
  return html`
      <section class="review-section" aria-labelledby="${content.id}-heading">
        <h2 id="${content.id}-heading">${content.heading}</h2>
        <p class="review-intro">${content.intro}</p>
        <ol id="${content.id}-list" class="cards review-cards-${content.id}">
      ${items.map(content.item)}
        </ol>
      </section>`;
}

/** The user's bookmarks of each kind, newest first, as the saved links page lists them. */
type BookmarksToReview = Record<ReviewKind, ReviewItem[]>;

/**
 * Reads the user's state input rows with the columns the page shows, in one query, and keeps the
 * Held and Failed bookmarks. The failure record is the one at the current schema version, which
 * the state is derived from, so `lastError` is that record's.
 */
async function readBookmarksToReview(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<BookmarksToReview> {
  const rows = await selectStateInputRows(db, userId, policy.schemaVersion, {
    url: bookmarks.url,
    title: bookmarks.title,
    createdAt: bookmarks.createdAt,
    lastError: enrichmentFailures.lastError,
  });
  const toReview: BookmarksToReview = { held: [], failed: [] };
  // The rows are oldest first, by the date saved and then the ID, so going through them backwards
  // gives the saved links page's order.
  for (const bookmark of collectStateInputs(rows, policy.schemaVersion).reverse()) {
    const kind = reviewKind(bookmark, policy);
    if (kind !== undefined) {
      const { bookmarkId: id, url, title, createdAt, lastError } = bookmark;
      toReview[kind].push({ id, url, title, createdAt, lastError });
    }
  }
  return toReview;
}

const PAGE_TITLE = "Links to review";

/**
 * The page every route here answers with. An outcome's message takes focus when the page loads
 * (`autofocus`), so a screen reader reads the result, and Tab goes on to the links that are left.
 * The IDs of the heading, the status region and the empty state are the saved links page's,
 * because the dialog script (delete-dialog.js) finds them by those IDs.
 */
function heldPage(
  { held, failed }: BookmarksToReview,
  outcome: Outcome | null,
  status: number,
): Response {
  const empty = held.length + failed.length === 0;
  const message = outcome === null ? null : html`<p tabindex="-1" autofocus>${outcome.message}</p>`;
  return htmlResponse(
    outcome === null ? PAGE_TITLE : `${outcome.title} - ${PAGE_TITLE}`,
    html`<h1 id="list-heading">${PAGE_TITLE}</h1>
      <div id="list-status" class="status" role="status">${message}</div>${section(HELD_SECTION, held)}${section(FAILED_SECTION, failed)}
      <div id="empty-state" class="empty-state"${empty ? null : html` hidden`}>
        <p><strong>Nothing to review.</strong> Links that Haystack holds back because they might be private, and links it couldn't describe, appear here.</p>
        <p><a href="/">Go to your saved links</a></p>
      </div>`,
    status,
    { signedIn: true, width: "wide", scripts: [DELETE_DIALOG_SCRIPT] },
  );
}

/** GET /held, and the page that Retry, a refused Release and a Delete from /held answer with. */
export async function showHeld(
  db: Db,
  userId: string,
  config: ReviewConfig,
  outcome: Outcome | null = null,
  status = 200,
): Promise<Response> {
  const toReview = await readBookmarksToReview(db, userId, readReviewPolicy(config));
  return heldPage(toReview, outcome, status);
}

// The user's own bookmark, by ID.
function owned(userId: string, bookmarkId: string) {
  return and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId));
}

async function isNotPrivateConfirmed(request: Request): Promise<boolean> {
  try {
    return (await request.formData()).get(NOT_PRIVATE_FIELD) === "yes";
  } catch {
    // Not a form submission. Nothing is released without the confirmation field.
    return false;
  }
}

/**
 * POST /bookmarks/:id/release. With the checkbox ticked, it records that the user confirmed the
 * link isn't private, which ends the Held state (isHeld), so the sweep can enrich it. A bookmark
 * that had reached the attempt limit before it was held is Failed once released, because Failed
 * comes after Held in the state's order, so the sweep leaves it alone. The page's own rows say
 * which it became, and the message says so, pointing to Retry. A reload
 * posts again and keeps the first time, which is what the calibration reads ("Probabilistic
 * check with Jev"). Without the checkbox, which only a browser that skips `required` or a request
 * built by hand can send, nothing changes, and the page says why.
 */
export async function releaseBookmark(
  request: Request,
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
): Promise<Response> {
  if (!(await isNotPrivateConfirmed(request))) {
    const bookmark = await db
      .select({ title: bookmarks.title })
      .from(bookmarks)
      .where(owned(userId, bookmarkId))
      .get();
    if (bookmark === undefined) {
      return notSavedPage();
    }
    return showHeld(
      db,
      userId,
      config,
      {
        title: `Not released “${bookmark.title}”`,
        message: `“${bookmark.title}” was not released. Tick “${NOT_PRIVATE_LABEL}” to release it.`,
      },
      400,
    );
  }
  const released = await db
    .update(bookmarks)
    .set({
      sensitivityAcknowledgedAt: sql`coalesce(${bookmarks.sensitivityAcknowledgedAt}, ${Date.now()})`,
    })
    .where(owned(userId, bookmarkId))
    .returning({ title: bookmarks.title })
    .get();
  if (released === undefined) {
    return notSavedPage();
  }
  const toReview = await readBookmarksToReview(db, userId, readReviewPolicy(config));
  const failed = toReview.failed.some((item) => item.id === bookmarkId);
  return heldPage(
    toReview,
    {
      title: `Released “${released.title}”`,
      message: failed
        ? `Released “${released.title}”. Haystack couldn't describe it before, so it's now under “${FAILED_SECTION.heading}”, where you can retry it.`
        : `Released “${released.title}”. Haystack can now describe it.`,
    },
    200,
  );
}

/**
 * POST /bookmarks/:id/retry. Deletes the bookmark's failure record at the current schema
 * version, which ends the Failed state, so the sweep tries it again in its next run, outside any
 * backoff window, because the window is the record's too. A record at another version is left
 * alone, because it is that version's count. A reload posts again, which does nothing more.
 *
 * The title is read first, for the message and for the 404. The deletion checks the owner again
 * itself, as release and delete do in their writes, so it can't touch another user's record
 * whatever the order of the statements.
 */
export async function retryBookmark(
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
): Promise<Response> {
  const bookmark = await db
    .select({ title: bookmarks.title })
    .from(bookmarks)
    .where(owned(userId, bookmarkId))
    .get();
  if (bookmark === undefined) {
    return notSavedPage();
  }
  await db.delete(enrichmentFailures).where(
    and(
      eq(enrichmentFailures.bookmarkId, bookmarkId),
      eq(enrichmentFailures.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
      exists(
        db
          .select({ id: bookmarks.id })
          .from(bookmarks)
          .where(
            and(eq(bookmarks.id, enrichmentFailures.bookmarkId), eq(bookmarks.userId, userId)),
          ),
      ),
    ),
  );
  return showHeld(db, userId, config, {
    title: `Retrying “${bookmark.title}”`,
    message: `Retrying “${bookmark.title}”. Haystack will try to describe it again soon.`,
  });
}
