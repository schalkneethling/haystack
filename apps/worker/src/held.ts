// The review page at /held (#129): the signed-in user's Held bookmarks, which wait for them to
// release or delete them, and their Failed bookmarks, which wait for them to retry or delete
// them. See "Reviewing Held bookmarks" and "Enrichment sweep" in
// plans/haystack-v1-implementation-plan.md.
//
// Each bookmark's state comes from the user's state input rows (state-inputs.ts), through
// collectStateInputs and deriveEnrichmentState, which the sweep's selection also derives its
// state with, so the page and the sweep can't disagree about which bookmarks are Held or Failed.
// Every lookup matches the bookmark's ID and the session's user together, and a miss gets the
// delete's 404 page, so no answer reveals that another user's bookmark exists.
//
// Release and Retry are ordinary forms that load the page again, with or without JavaScript,
// because each is one quick write. Delete is the delete endpoint's (delete-bookmark.ts), whose
// dialog script works here as on the saved links page.
import { and, eq, exists, gte, sql } from "drizzle-orm";
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
  type EnrichmentState,
  type EnrichmentStateInputs,
  type EnrichmentStatePolicy,
  readSensitiveWarnThreshold,
  type SensitiveWarnThresholdConfig,
} from "./enrichment/state.ts";
import { html, type SafeHtml } from "./html.ts";
import {
  isNotPrivateConfirmed,
  NOT_PRIVATE_LABEL,
  notPrivateCheckbox,
} from "./not-private-checkbox.ts";
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

// The checkbox is the save form's too (not-private-checkbox.ts). It is described by the title,
// because every Held card's checkbox has the same label. The release form's box is left out of
// the layout (site.css), so the checkbox gets a row of its own above Release and Delete.
function heldItem(item: ReviewItem): SafeHtml {
  return html`<li id="bookmark-${item.id}">
        ${itemStart(item)}
        <div class="card-actions">
          <form class="release-form" method="post" action="${bookmarkAction(item.id, "release")}">
            ${notPrivateCheckbox({ id: `not-private-${item.id}`, describedBy: `title-${item.id}` })}
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
 * The page every route here answers with. An outcome is in the page title and in the status
 * message, and focus is the browser's to handle when the page loads, as on the saved links page.
 * The IDs of the heading, the status region and the empty state are the saved links page's,
 * because the dialog script (delete-dialog.js) finds them by those IDs.
 */
function heldPage(
  { held, failed }: BookmarksToReview,
  outcome: Outcome | null,
  status: number,
): Response {
  const empty = held.length + failed.length === 0;
  const message = outcome === null ? null : html`<p>${outcome.message}</p>`;
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

/**
 * GET /held, and the page that Retry, a refused Release and a Delete from /held answer with. It
 * takes the policy rather than the configuration, so an action reads the policy before it writes
 * anything, and a configuration that can't be read answers 500 with nothing changed.
 */
export async function showHeld(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
  outcome: Outcome | null = null,
  status = 200,
): Promise<Response> {
  return heldPage(await readBookmarksToReview(db, userId, policy), outcome, status);
}

// The user's own bookmark, by ID.
function owned(userId: string, bookmarkId: string) {
  return and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId));
}

interface OwnBookmark {
  title: string;
  inputs: EnrichmentStateInputs;
  state: EnrichmentState;
}

/**
 * The user's bookmark with its state, derived as the page derives every bookmark's, or undefined
 * when it isn't the user's. Release and Retry read it before they write, so each acts only on a
 * bookmark in the state it is for.
 */
async function readOwnBookmark(
  db: Db,
  userId: string,
  bookmarkId: string,
  policy: EnrichmentStatePolicy,
): Promise<OwnBookmark | undefined> {
  const rows = await selectStateInputRows(
    db,
    userId,
    policy.schemaVersion,
    { title: bookmarks.title },
    bookmarkId,
  );
  const [inputs] = collectStateInputs(rows, policy.schemaVersion);
  return inputs === undefined
    ? undefined
    : { title: inputs.title, inputs, state: deriveEnrichmentState(inputs, policy) };
}

/**
 * The answer when the bookmark isn't in the state the action is for, which happens when /held is
 * open in two tabs, or the threshold changed since the page loaded. Nothing was written. It is a
 * 409, because the request is well formed and the bookmark exists, but it conflicts with the
 * bookmark's current state.
 */
function notInStatePage(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
  outcome: Outcome,
): Promise<Response> {
  return showHeld(db, userId, policy, outcome, 409);
}

async function isReleaseConfirmed(request: Request): Promise<boolean> {
  try {
    return isNotPrivateConfirmed(await request.formData());
  } catch {
    // Not a form submission. Nothing is released without the confirmation field.
    return false;
  }
}

/**
 * POST /bookmarks/:id/release. With the checkbox ticked, it records that the user confirmed the
 * link isn't private, which ends the Held state (isHeld), so the sweep can enrich it. Only a
 * bookmark that is Held is released, so an acknowledgment always means that the owner saw the
 * link held back and released it. A bookmark that was never checked (a NULL noul) would
 * otherwise skip the gate when Jev checks it later, and a lowered threshold wouldn't hold it.
 *
 * A bookmark that is acknowledged already gets the same answer as a first release, without a
 * write, so a reload, or Release in a second tab, is harmless, and the first time is kept, which
 * is what the calibration reads ("Probabilistic check with Jev"). Any other state writes nothing
 * and gets a 409 (notInStatePage). Without the checkbox, which only a browser that skips
 * `required` or a request built by hand can send, nothing changes, and the page says why.
 *
 * A bookmark that had reached the attempt limit before it was held is Failed once released,
 * because Failed comes after Held in the state's order, so the sweep leaves it alone. The page's
 * own rows say which it became, and the message says so, pointing to Retry.
 *
 * The state is read, then written, in two statements. Nothing else between them can make a Held
 * bookmark stop being Held in a way that matters: the sweep never acknowledges a bookmark, and
 * writes a noul only when there is none, which a Held bookmark has; the threshold changes only
 * with a deploy; and another release keeps the first time (`coalesce`). A delete in between
 * leaves nothing to update, which is the 404. So the write doesn't repeat isHeld in SQL.
 */
export async function releaseBookmark(
  request: Request,
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
): Promise<Response> {
  const policy = readReviewPolicy(config);
  const confirmed = await isReleaseConfirmed(request);
  const bookmark = await readOwnBookmark(db, userId, bookmarkId, policy);
  if (bookmark === undefined) {
    return notSavedPage();
  }
  const { title } = bookmark;
  if (!confirmed) {
    return showHeld(
      db,
      userId,
      policy,
      {
        title: `Not released “${title}”`,
        message: `“${title}” was not released. Tick “${NOT_PRIVATE_LABEL}” to release it.`,
      },
      400,
    );
  }
  const acknowledged = bookmark.inputs.sensitivityAcknowledgedAt !== null;
  if (!acknowledged && bookmark.state !== "held") {
    return notInStatePage(db, userId, policy, {
      title: `Nothing to release for “${title}”`,
      message: `“${title}” isn't held back, so there was nothing to release.`,
    });
  }
  if (!acknowledged) {
    const released = await db
      .update(bookmarks)
      .set({
        sensitivityAcknowledgedAt: sql`coalesce(${bookmarks.sensitivityAcknowledgedAt}, ${Date.now()})`,
      })
      .where(owned(userId, bookmarkId))
      .returning({ id: bookmarks.id })
      .get();
    if (released === undefined) {
      return notSavedPage();
    }
  }
  const toReview = await readBookmarksToReview(db, userId, policy);
  const failed = toReview.failed.some((item) => item.id === bookmarkId);
  return heldPage(
    toReview,
    {
      title: `Released “${title}”`,
      message: failed
        ? `Released “${title}”. Haystack couldn't describe it before, so it's now under “${FAILED_SECTION.heading}”, where you can retry it.`
        : `Released “${title}”. Haystack can now describe it.`,
    },
    200,
  );
}

/**
 * POST /bookmarks/:id/retry. Deletes the bookmark's failure record at the current schema
 * version, which ends the Failed state, so the sweep tries it again in its next run, outside any
 * backoff window, because the window is the record's too. A record at another version is left
 * alone, because it is that version's count.
 *
 * Only a Failed bookmark is retried, so Retry can't reset the backoff of a bookmark the sweep is
 * still trying, and let it skip the queue. A bookmark with no record at the current version, as
 * after a reload, gets the same answer as a retry, because there is nothing left to do. A
 * bookmark that has a record but isn't Failed writes nothing and gets a 409 (notInStatePage).
 *
 * The state is read, then the record deleted, in two statements. The deletion checks the owner
 * itself, as release and delete do in their writes, and that the record is at the attempt limit,
 * which is the part of Failed that the record holds. In between, the sweep can only make a
 * Failed bookmark more Failed, because it doesn't select one, and it can't make a bookmark Held,
 * which Release alone ends. A bookmark that another run enriched in between has an enrichment at
 * the current version, whose write deletes the record anyway.
 */
export async function retryBookmark(
  db: Db,
  userId: string,
  bookmarkId: string,
  config: ReviewConfig,
): Promise<Response> {
  const policy = readReviewPolicy(config);
  const bookmark = await readOwnBookmark(db, userId, bookmarkId, policy);
  if (bookmark === undefined) {
    return notSavedPage();
  }
  const { title } = bookmark;
  if (bookmark.inputs.failure !== null && bookmark.state !== "failed") {
    return notInStatePage(db, userId, policy, {
      title: `Nothing to retry for “${title}”`,
      message: `“${title}” isn't waiting for a retry.`,
    });
  }
  if (bookmark.inputs.failure !== null) {
    await db.delete(enrichmentFailures).where(
      and(
        eq(enrichmentFailures.bookmarkId, bookmarkId),
        eq(enrichmentFailures.schemaVersion, policy.schemaVersion),
        gte(enrichmentFailures.attempts, policy.attemptLimit),
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
  }
  return showHeld(db, userId, policy, {
    title: `Retrying “${title}”`,
    message: `Retrying “${title}”. Haystack will try to describe it again soon.`,
  });
}
