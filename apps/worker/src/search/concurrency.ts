// How many of search's requests to Jev are in flight at once (#211). See "Request modes" in
// plans/haystack-v1-implementation-plan.md.

/**
 * The most requests one search has in flight at once, batched mode's chunks (#211) and pair
 * mode's requests (#213) alike. Haystack's own number, below the limiter's 10 requests a second
 * (jev-limiter.ts), so that one search can't take every request of a second by itself.
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
