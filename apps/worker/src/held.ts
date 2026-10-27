// The review page at /held (#129): the signed-in user's Held bookmarks, which wait for them to
// release or delete them, and their Failed bookmarks, which wait for them to retry or delete
// them. See "Reviewing Held bookmarks" and "Enrichment sweep" in
// plans/haystack-v1-implementation-plan.md.
//
// Each bookmark's state comes from readEnrichmentStateInputs and deriveEnrichmentState, which the
// sweep's selection also derives its state with, so the page and the sweep can't disagree about
// which bookmarks are Held or Failed. Every lookup matches the bookmark's ID and the session's
// user together, and a miss gets the delete's 404 page, so no answer reveals that another user's
// bookmark exists.
//
// Release and Retry are ordinary forms that load the page again, with or without JavaScript,
// because each is one quick write. Delete is the delete endpoint's (delete-bookmark.ts), whose
// dialog script works here as on the saved links page.
import { and, desc, eq, sql } from "drizzle-orm";
import { DELETE_DIALOG_SCRIPT, deleteForm, savedDate } from "./bookmark-card.ts";
import { bookmarkAction, HELD_PATH } from "./bookmark-paths.ts";
import type { Db } from "./db/client.ts";
import { bookmarks, enrichmentFailures } from "./db/schema.ts";
import type { EnrichmentFailureReason, EnrichmentStep } from "./enrichment/enrich-bookmark.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "./enrichment/enrichment-schema.ts";
import { readEnrichmentStateInputs } from "./enrichment/state-inputs.ts";
import {
  deriveEnrichmentState,
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

interface IdsToReview {
  held: Set<string>;
  failed: Set<string>;
}

async function idsToReview(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<IdsToReview> {
  const ids: IdsToReview = { held: new Set(), failed: new Set() };
  for (const inputs of await readEnrichmentStateInputs(db, userId, policy.schemaVersion)) {
    const state = deriveEnrichmentState(inputs, policy);
    if (state === "held" || state === "failed") {
      ids[state].add(inputs.bookmarkId);
    }
  }
  return ids;
}

/** How many of the user's bookmarks are Held or Failed, for the link on the saved links page. */
export async function countBookmarksToReview(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<number> {
  const { held, failed } = await idsToReview(db, userId, policy);
  return held.size + failed.size;
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

// The page shows the host, not the whole address, because a Held link may carry a secret.
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // POST /save stores only URLs that parse, so only a change made by hand gets here.
    return "an address Haystack can't read";
  }
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
        <p class="address">${host(item.url)}</p>`;
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

/**
 * The user's bookmarks of each kind, newest first, as the saved links page lists them. The state
 * is derived first, from readEnrichmentStateInputs, and a second query reads what the page shows.
 * It reads every one of the user's bookmarks rather than the ones to review by ID, because D1
 * takes at most 100 bound parameters, and lowering the threshold could hold more than that.
 */
async function readBookmarksToReview(
  db: Db,
  userId: string,
  policy: EnrichmentStatePolicy,
): Promise<{ held: ReviewItem[]; failed: ReviewItem[] }> {
  const ids = await idsToReview(db, userId, policy);
  const toReview = { held: [] as ReviewItem[], failed: [] as ReviewItem[] };
  if (ids.held.size + ids.failed.size === 0) {
    return toReview;
  }
  const rows = await db
    .select({
      id: bookmarks.id,
      url: bookmarks.url,
      title: bookmarks.title,
      createdAt: bookmarks.createdAt,
      lastError: enrichmentFailures.lastError,
    })
    .from(bookmarks)
    .leftJoin(
      enrichmentFailures,
      and(
        eq(enrichmentFailures.bookmarkId, bookmarks.id),
        eq(enrichmentFailures.schemaVersion, policy.schemaVersion),
      ),
    )
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id));
  for (const row of rows) {
    if (ids.held.has(row.id)) {
      toReview.held.push(row);
    } else if (ids.failed.has(row.id)) {
      toReview.failed.push(row);
    }
  }
  return toReview;
}

const PAGE_TITLE = "Links to review";

/**
 * GET /held, and the page every action here answers with. An outcome's message takes focus when
 * the page loads (`autofocus`), so a screen reader reads the result, and Tab goes on to the
 * links that are left. The IDs of the heading, the status region and the empty state are the
 * saved links page's, because the dialog script (delete-dialog.js) finds them by those IDs.
 */
export async function showHeld(
  db: Db,
  userId: string,
  config: ReviewConfig,
  outcome: Outcome | null = null,
  status = 200,
): Promise<Response> {
  const { held, failed } = await readBookmarksToReview(db, userId, readReviewPolicy(config));
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
 * link isn't private, which ends the Held state (isHeld), so the sweep can enrich it. A reload
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
  return showHeld(db, userId, config, {
    title: `Released “${released.title}”`,
    message: `Released “${released.title}”. Haystack can now describe it.`,
  });
}

/**
 * POST /bookmarks/:id/retry. Deletes the bookmark's failure record at the current schema
 * version, which ends the Failed state, so the sweep tries it again in its next run, outside any
 * backoff window, because the window is the record's too. A record at another version is left
 * alone, because it is that version's count. A reload posts again, which does nothing more.
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
  await db
    .delete(enrichmentFailures)
    .where(
      and(
        eq(enrichmentFailures.bookmarkId, bookmarkId),
        eq(enrichmentFailures.schemaVersion, ENRICHMENT_SCHEMA_VERSION),
      ),
    );
  return showHeld(db, userId, config, {
    title: `Retrying “${bookmark.title}”`,
    message: `Retrying “${bookmark.title}”. Haystack will try to describe it again soon.`,
  });
}
