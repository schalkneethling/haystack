// POST /api/search/click (#215): records that a person followed a search result, by setting
// `clicked` on the run's answer for that bookmark, a weak relevance label for Phase 12. The search
// page sends it with `navigator.sendBeacon` as the person leaves for the saved page (search.js), so
// the request can't carry a header of its own: what tells the Worker who sent it, and from where,
// is the session cookie and the Origin header that the browser adds to every POST. The entry point
// has checked both, as for every route, and passes the session's user.
//
// The answers:
//
// - 204 with no body when the answer is now clicked, whether it was or not: following the same
//   result twice leaves `clicked` at 1.
// - 404 with `{ code: "SEARCH_ANSWER_NOT_FOUND" }` for any miss, with one answer for all of them,
//   as the delete endpoint answers (plan, "Deleting bookmarks"): no such run, another user's run,
//   no such bookmark in that run, and a deleted bookmark, whose answers were deleted with it. The
//   answer never reveals that another user's run exists.
// - 400 with `{ code: "SEARCH_CLICK_INVALID" }` for a body that isn't the shape of
//   `SearchClickRequest`, and 413 with `SEARCH_CLICK_TOO_LARGE` for one over MAX_BODY_BYTES. A body
//   is never echoed.
import { SearchClickRequest } from "@haystack/schemas";
import { and, eq, exists } from "drizzle-orm";
import * as v from "valibot";
import type { Db } from "./db/client.ts";
import { searchAnswers, searchRuns } from "./db/schema.ts";
import { readText } from "./enrichment/bounded-read.ts";
import { jsonResponse } from "./page.ts";

/** The route's path. search.js has its own copy of it, because the assets can't import this. */
export const SEARCH_CLICK_PATH = "/api/search/click";

/**
 * The most of a request's body that is read. Two IDs of 64 characters each, the most the schema
 * allows, and the body's syntax come to about 170 bytes, so 1 KiB is headroom. The rest is
 * cancelled, never read.
 */
const MAX_BODY_BYTES = 1024;

const REFUSALS = {
  invalid: { status: 400, code: "SEARCH_CLICK_INVALID" },
  tooLarge: { status: 413, code: "SEARCH_CLICK_TOO_LARGE" },
  notFound: { status: 404, code: "SEARCH_ANSWER_NOT_FOUND" },
} as const;

function refusal({ status, code }: (typeof REFUSALS)[keyof typeof REFUSALS]): Response {
  return jsonResponse({ code }, status);
}

/**
 * Sets `clicked` on the answer in the body's run for the body's bookmark, when the run is the
 * session's user's. The answer is looked up through the run, and the run through the user, in the
 * one statement that updates it, so no other user's answer can be reached, and a miss for any
 * reason is one 404.
 *
 * The body is read as JSON whatever its content type, because `sendBeacon` sends the type of the
 * `Blob` it is given or, for a string, `text/plain`, and the route has nothing to choose between.
 * The update is given to `waitUntil` as well as awaited, because a person who closes the tab right
 * after the click disconnects, and the runtime may cancel a request's work on a disconnect.
 */
export async function postSearchClick(
  request: Request,
  context: Pick<ExecutionContext, "waitUntil">,
  db: Db,
  userId: string,
): Promise<Response> {
  const body =
    request.body === null
      ? { text: "", complete: true }
      : await readText(request.body, MAX_BODY_BYTES);
  if (!body.complete) {
    return refusal(REFUSALS.tooLarge);
  }
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return refusal(REFUSALS.invalid);
  }
  const parsed = v.safeParse(SearchClickRequest, json);
  if (!parsed.success) {
    return refusal(REFUSALS.invalid);
  }
  const { runId, bookmarkId } = parsed.output;

  const marking = db
    .update(searchAnswers)
    .set({ clicked: true })
    .where(
      and(
        eq(searchAnswers.searchRunId, runId),
        eq(searchAnswers.bookmarkId, bookmarkId),
        exists(
          db
            .select({ id: searchRuns.id })
            .from(searchRuns)
            .where(
              and(eq(searchRuns.id, searchAnswers.searchRunId), eq(searchRuns.userId, userId)),
            ),
        ),
      ),
    )
    .returning({ bookmarkId: searchAnswers.bookmarkId })
    .get();
  context.waitUntil(marking.catch(() => undefined));
  const marked = await marking;
  return marked === undefined ? refusal(REFUSALS.notFound) : new Response(null, { status: 204 });
}
