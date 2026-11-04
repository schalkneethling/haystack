// How many of search's requests to Jev are in flight at once (#211). See "Request modes" in
// plans/haystack-v1-implementation-plan.md.

/**
 * The most requests one search has in flight at once, batched mode's chunks (#211) and pair
 * mode's requests (#213) alike. Haystack's own number. It doesn't limit the rate: 4 in flight
 * with answers of about 300 ms is about 13 requests a second, and only the limiter
 * (jev-limiter.ts) keeps that under its ceilings. It limits the Worker's open connections.
 * Cloudflare's limits page (https://developers.cloudflare.com/workers/platform/limits/, last
 * updated 2026-10-29, read on 2026-11-04) says "Each Worker invocation can have up to six
 * connections simultaneously waiting for response headers", and a seventh "is queued until one
 * of the existing connections receives its response headers". The client starts each attempt's
 * time limit when it calls `fetch`, so a request queued there would spend its 5 seconds waiting
 * for a connection rather than for Jev. 4 stays under 6 and leaves room for the invocation's
 * other subrequests, and it keeps the answers being parsed at once, which is CPU time, to a few.
 */
export const SEARCH_JEV_CONCURRENCY = 4;

/** Runs a task when fewer than the limit are running, and resolves or rejects as it does. */
export type ConcurrencyLimit = <Result>(task: () => Promise<Result>) => Promise<Result>;

/**
 * A limit of `limit` tasks at once. Tasks start in the order they were given. Throws a
 * RangeError for a limit that isn't a whole number from 1, which is a bug in the caller.
 */
export function concurrencyLimit(limit: number): ConcurrencyLimit {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit is ${limit}, which isn't a whole number from 1`);
  }
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= limit) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else {
      running += 1;
    }
    try {
      return await task();
    } finally {
      // The next task takes this one's place, so `running` stays as it is.
      const next = waiting.shift();
      if (next === undefined) {
        running -= 1;
      } else {
        next();
      }
    }
  };
}
