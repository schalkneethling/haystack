// POST /api/search (#214): the search page's route, and a thin caller of the search service
// (#212). It resolves nothing about the user from the request: the entry point has already
// checked the session and the Origin, and passes the session's user. It validates the body with
// the shared schema, reads the search settings and the Held policy once, calls `searchBookmarks`,
// and answers with the service's result as it is. It does no ranking, no thresholding and no
// logging of its own, so WebMCP and MCP (Milestone 4) get the same search by calling the service.
//
// The answer, which the search page (search.js) reads:
//
// - 200 with a `SearchAnswer`: `runId`, `outcome` (`ok` or `partial`) and the results, as the
//   service returned them, in its order.
// - 502 with `{ code: "SEARCH_UNAVAILABLE" }` for the service's `failed` outcome, a search that
//   Jev answered not at all. This is the route's one mapping that isn't a pass-through (see
//   `postSearch`). The page shows its error state for any status but 200 and 401.
// - 499 with no body for a search the page abandoned (see `postSearch`), the route's other.
// - 400 with `{ code }` for a body that isn't JSON (`SEARCH_REQUEST_INVALID`) or whose query
//   the shared schema refuses (`SEARCH_QUERY_INVALID`, also the service's rejection code), and
//   413 with `SEARCH_REQUEST_TOO_LARGE` for a body past MAX_BODY_BYTES. A body is never echoed,
//   so no answer holds the query.
//
// Anything else that goes wrong, such as an empty key or a failed database read, throws to the
// entry point, which answers 500 and logs the error's code and never its message.
import { SearchRequest } from "@haystack/schemas";
import type { SearchAnswer } from "@haystack/schemas";
import * as v from "valibot";
import type { Db } from "./db/client.ts";
import { readText } from "./enrichment/bounded-read.ts";
import type { JevConfig } from "./enrichment/jev-client.ts";
import { errorCode } from "./error-code.ts";
import { type FlagReader, readSearchSettings } from "./flags.ts";
import { readReviewPolicy, type ReviewConfig } from "./held.ts";
import { jsonResponse } from "./page.ts";
import { SearchRejectedError, searchBookmarks } from "./search/search-bookmarks.ts";

/** The route's path. search.js has its own copy of it, because the assets can't import this. */
export const SEARCH_API_PATH = "/api/search";

/**
 * The most of a request's body that is read. A query is at most SEARCH_QUERY_CAP characters, and
 * the most a character takes in a JSON body is 6 bytes, when it is escaped as `\uXXXX`, so 3 KB
 * holds the longest query and the body's own syntax. The cap is 8 KiB, which is that 3 KB and
 * headroom for whitespace and fields the route ignores, and a test checks that a query of the cap
 * written with every character escaped is accepted. The rest is cancelled, never read, so a body
 * of any size costs this much memory and CPU time.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** What the route reads from the Worker's environment. `Env` has all of it. */
export type SearchRouteEnv = JevConfig & ReviewConfig & { readonly FLAGS: FlagReader };

/** The service the route calls. A test passes a fake. */
export type SearchService = typeof searchBookmarks;

/** The statuses of the answers that are not a `SearchAnswer`, with the codes of their bodies. */
const REFUSALS = {
  invalidRequest: { status: 400, code: "SEARCH_REQUEST_INVALID" },
  invalidQuery: { status: 400, code: "SEARCH_QUERY_INVALID" },
  tooLarge: { status: 413, code: "SEARCH_REQUEST_TOO_LARGE" },
  unavailable: { status: 502, code: "SEARCH_UNAVAILABLE" },
} as const;

function refusal({ status, code }: (typeof REFUSALS)[keyof typeof REFUSALS]): Response {
  return jsonResponse({ code }, status);
}

/**
 * Searches the user's bookmarks for the query in the request's body, for the search page, which
 * types its query: the channel is `web` and the input mode `typed`, until the page's voice input
 * (Phase 13) sends its own.
 *
 * Two answers aren't the service's result as it is. A `failed` search is 502, because it isn't an
 * answer: Jev answered none of it, and a 200 with no results would read, on the page and to an
 * agent, as a search that found nothing. 502 and not 503, because the Worker is a gateway to Jev
 * and got no usable answer from it, which also tells a Jev outage in Cloudflare's metrics from the
 * 500 of a fault in Haystack's own code. It has no `Retry-After`: the page doesn't read it, a
 * person presses Try again, and nothing says when Jev will be back.
 *
 * A search that the page abandoned, by its time limit, by a changed query or by leaving, is 499,
 * nginx's "client closed request", whatever its outcome, because nobody reads the answer. A 502
 * there would count in the metrics as a Jev outage, which every changed query would then look
 * like. The runtime may cancel the handler on a disconnect before it answers, so 499 is what the
 * handler answers only if it survives it, and Cloudflare's metrics count a disconnect as a status
 * of their own, so a disconnect isn't read as a Jev outage either way. The request's signal also
 * ends the search itself, so that it stops asking Jev: a request not yet sent is not sent (see
 * `SearchContext.signal`). The search is still logged, with the reason `aborted`, even if the
 * handler is cancelled, because it is also given to `waitUntil` (see below), and every search
 * that passes validation is logged.
 *
 * Needs the `enable_request_signal` compatibility flag until the compatibility date of
 * 2026-11-17 (wrangler.jsonc), because without it `request.signal` never aborts.
 */
export async function postSearch(
  request: Request,
  context: Pick<ExecutionContext, "waitUntil">,
  db: Db,
  userId: string,
  env: SearchRouteEnv,
  search: SearchService = searchBookmarks,
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
    return refusal(REFUSALS.invalidRequest);
  }
  const parsed = v.safeParse(SearchRequest, json);
  if (!parsed.success) {
    return refusal(REFUSALS.invalidQuery);
  }

  // The search is started here, given to `waitUntil` and then awaited for the answer. When the
  // client disconnects, the runtime may cancel what the handler is doing ("tasks associated with
  // that request may be canceled", Workers limits), which would lose the run before it is logged,
  // and #212's rule is that every search that passes validation is. `waitUntil` keeps it running
  // for up to 30 seconds after the response or the disconnect, and the search ends in at most
  // SEARCH_DEADLINE_MS plus the attempt under way, 25 seconds, and its log, so the log fits.
  // The promise given to `waitUntil` never rejects. While the client is connected, a failure is the
  // handler's to rethrow to the entry point, which logs it. After a disconnect the handler may be
  // cancelled before it does, so the background branch logs it, by its code only, and the handler
  // then answers 499 instead of rethrowing, so that the failure is logged once. A rejection's two
  // readers run in the same step, so both see the same `request.signal.aborted`.
  const searching = (async () =>
    search(
      userId,
      parsed.output.query,
      { channel: "web", inputMode: "typed" },
      {
        db,
        jev: env,
        settings: await readSearchSettings(env.FLAGS),
        policy: readReviewPolicy(env),
        signal: request.signal,
      },
    ))();
  context.waitUntil(
    searching.catch((error: unknown) => {
      if (request.signal.aborted && !(error instanceof SearchRejectedError)) {
        console.error("Search failed after the client left:", errorCode(error));
      }
    }),
  );
  let result: Awaited<ReturnType<SearchService>>;
  try {
    result = await searching;
  } catch (error) {
    if (error instanceof SearchRejectedError) {
      return jsonResponse({ code: error.code }, REFUSALS.invalidQuery.status);
    }
    if (request.signal.aborted) {
      // Logged by the background branch, and nobody reads an answer.
      return new Response(null, { status: 499 });
    }
    throw error;
  }

  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }
  if (result.outcome === "failed") {
    return refusal(REFUSALS.unavailable);
  }
  return jsonResponse(
    {
      runId: result.runId,
      outcome: result.outcome,
      results: [...result.results],
    } satisfies SearchAnswer,
    200,
  );
}
