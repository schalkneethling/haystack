// The client-side limiter for search's requests to Jev (#211). See "Jev model limits" and "Jev
// client" in plans/haystack-v1-implementation-plan.md.
//
// TypeSafe limits each organization in requests per second and in tokens per second, and answers
// a request over either with `429`. One chunk can hold up to 64k tokens, so a few chunks can use up
// the tokens of a second with few requests, and pair mode (#213) can use up the requests with few
// tokens. The limiter holds both, so that a burst of searches waits its turn here rather than
// cascading into `429` responses, and the client's own backoff on `429` and `529` stays as it is.
//
// It keeps a log of what it let through in the last second: each request's moment and its
// estimated tokens. A request may go when, with it, the last second holds no more requests than
// `requestsPerSecond` and no more tokens than `tokensPerSecond`. Otherwise it sleeps until the
// oldest entries that are in its way are a second old. Requests go in the order they asked, so a
// large one isn't overtaken for good by smaller ones that would fit sooner.
//
// A request of more tokens than a second's ceiling, such as one with the long-context option of
// 262k tokens, which Phase 11 never sends, could never fit. It goes alone, once no other request's
// tokens count, and its tokens then count for as many seconds as the ceiling needs to pay them
// back, so that the rate over time stays at the ceiling.
//
// After a `429`, every request waits for as long as the response asked, or LIMITER_DEFAULT_PAUSE_MS
// when it asked for no time, and never longer than JEV_MAX_RETRY_DELAY_MS: the client stops a
// request that is asked to wait longer, and the others shouldn't wait for longer than that.
//
// The ceilings are Haystack's own constants, not the account's limits, which #202 deliberately
// didn't record. They start conservative and are tuned from what real searches see. The limiter
// lives in the isolate's memory: with one user, a limiter per isolate is enough, so no state is
// shared between isolates.
import { JEV_MAX_RETRY_DELAY_MS, type JevRequestGate } from "../enrichment/jev-client.ts";

/** The time the limiter reads and waits on. Tests give it a fake one. */
export interface LimiterClock {
  now(): number;
  /** Resolves after `milliseconds`, or as soon as `signal` is aborted. */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** The Worker's own clock. */
export const SYSTEM_CLOCK: LimiterClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The limiter's ceilings, per second. */
export interface JevRateLimits {
  readonly requestsPerSecond: number;
  readonly tokensPerSecond: number;
}

/**
 * Haystack's own conservative ceilings for search (#202). The only figures TypeSafe ever
 * published were 250,000 tokens per second and 1,200 requests a minute, 20 a second, for Jev
 * 1.13, and these are well below both. 100,000 tokens a second still lets one full chunk of 64k
 * tokens through at once, so a search of a few chunks waits a second or two at most.
 */
export const SEARCH_JEV_LIMITS: JevRateLimits = { requestsPerSecond: 10, tokensPerSecond: 100_000 };

/** How long every request waits after a `429` that asked for no wait: a second of the log. */
export const LIMITER_DEFAULT_PAUSE_MS = 1000;

const WINDOW_MS = 1000;

// A request the limiter let through: when, and until when its tokens count.
interface Entry {
  readonly at: number;
  readonly tokens: number;
  readonly tokensCountUntil: number;
}

export class JevLimiter {
  readonly #limits: JevRateLimits;
  readonly #clock: LimiterClock;
  #log: Entry[] = [];
  #pausedUntil = Number.NEGATIVE_INFINITY;
  // Settles when the request ahead in line has gone or given up.
  #line: Promise<void> = Promise.resolve();

  constructor(limits: JevRateLimits, clock: LimiterClock = SYSTEM_CLOCK) {
    this.#limits = limits;
    this.#clock = clock;
  }

  /**
   * Resolves true when a request of `tokens`, its estimate, may be sent, and counts it from then
   * on. Resolves false, and counts nothing, once `signal` is aborted. Throws a RangeError for a
   * token count that isn't a whole number from 0, which is a bug in the caller.
   */
  async acquire(tokens: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new RangeError(`tokens is ${tokens}, which isn't a whole number from 0`);
    }
    const ahead = this.#line;
    let leave!: () => void;
    this.#line = new Promise((resolve) => {
      leave = resolve;
    });
    try {
      await waitFor(ahead, signal);
      for (;;) {
        if (signal?.aborted) {
          return false;
        }
        const wait = this.#waitMs(tokens);
        if (wait <= 0) {
          break;
        }
        await this.#clock.sleep(wait, signal);
      }
      const now = this.#clock.now();
      this.#log.push({
        at: now,
        tokens,
        tokensCountUntil: now + WINDOW_MS * Math.max(1, tokens / this.#limits.tokensPerSecond),
      });
      return true;
    } finally {
      // A request that gave up while still in line lets the next one go only once the one ahead
      // of it has, so the order holds.
      void ahead.then(leave);
    }
  }

  /**
   * Jev answered `429`. Every request waits `retryAfterMs`, or LIMITER_DEFAULT_PAUSE_MS when it
   * is undefined, up to JEV_MAX_RETRY_DELAY_MS. A longer pause already under way is kept.
   */
  throttled(retryAfterMs: number | undefined): void {
    const pause = Math.min(retryAfterMs ?? LIMITER_DEFAULT_PAUSE_MS, JEV_MAX_RETRY_DELAY_MS);
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#clock.now() + pause);
  }

  /** The gate for one request of `tokens`, which askJevQuestions waits on before each attempt. */
  gate(tokens: number): JevRequestGate {
    return {
      wait: async (signal) => {
        await this.acquire(tokens, signal);
      },
      throttled: (retryAfterMs) => {
        this.throttled(retryAfterMs);
      },
    };
  }

  // How long a request of `tokens` has to wait from now, or 0 when it may go.
  #waitMs(tokens: number): number {
    const now = this.#clock.now();
    this.#log = this.#log.filter(
      ({ at, tokensCountUntil }) => at + WINDOW_MS > now || tokensCountUntil > now,
    );
    const waits = [this.#pausedUntil - now];
    // The requests of the last second, oldest first, since the log is kept in that order.
    const recent = this.#log.filter(({ at }) => at + WINDOW_MS > now);
    const { requestsPerSecond, tokensPerSecond } = this.#limits;
    if (recent.length >= requestsPerSecond) {
      const oldestInTheWay = recent[recent.length - requestsPerSecond];
      waits.push(oldestInTheWay!.at + WINDOW_MS - now);
    }
    const counting = this.#log
      .filter(({ tokensCountUntil }) => tokensCountUntil > now)
      .sort((a, b) => a.tokensCountUntil - b.tokensCountUntil);
    // A request over the ceiling goes only when nothing else counts, so it needs room for all of
    // a second's tokens.
    const needed = Math.min(tokens, tokensPerSecond);
    let counted = counting.reduce((sum, entry) => sum + entry.tokens, 0);
    for (const entry of counting) {
      if (counted + needed <= tokensPerSecond) {
        break;
      }
      counted -= entry.tokens;
      waits.push(entry.tokensCountUntil - now);
    }
    return Math.max(...waits);
  }
}

// Resolves when `promise` settles, or when `signal` is aborted, whichever comes first.
function waitFor(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) {
      done();
    }
    void promise.then(done);
  });
}

/**
 * The limiter that search's requests in this isolate share: batched mode's chunks (#211) and pair
 * mode's requests (#213).
 */
export const ISOLATE_JEV_LIMITER = new JevLimiter(SEARCH_JEV_LIMITS);
