// The client-side limiter for search's requests to Jev (#211). See "Jev model limits" and "Jev
// client" in plans/haystack-v1-implementation-plan.md.
//
// TypeSafe limits each organization in requests per second and in tokens per second, and answers
// a request over either with `429`. One chunk can hold up to 64k tokens, so a few chunks can use up
// the tokens of a second with few requests, and pair mode (#213) can use up the requests with few
// tokens. The limiter holds both, so that a burst of searches waits its turn here rather than
// cascading into `429` responses, and the client's own backoff on `429` and `529` stays as it is.
//
// It keeps a log of each request's send time and its estimated tokens. A request reserves its send
// time when it asks, at once and without waiting on anything: the earliest moment, no earlier than
// any time already reserved, at which the second up to it holds no more requests than
// `requestsPerSecond` and no more tokens than `tokensPerSecond`, the request included. It then
// sleeps on its own timer until that moment. Because each reservation comes after every earlier
// one, requests go in the order they asked, so a large one isn't overtaken for good by smaller
// ones that would fit sooner.
//
// No request ever waits on another request's promise. The limiter is the isolate's, shared by
// every search, and Cloudflare can cancel a request's pending work when its client disconnects, so
// a request may never come back from its sleep. It then leaves only its reservation, which counts
// for its second like any other and then expires, and the requests after it go at their own times.
// A request that is aborted while it sleeps gives its reservation back. The requests that reserved
// after it keep their times, which are later than they need be but never early.
//
// A request of more tokens than a second's ceiling, such as one with the long-context option of
// 262k tokens, which Phase 11 never sends, could never fit. It goes alone, once no other request's
// tokens count, and its tokens then count for as many seconds as the ceiling needs to pay them
// back, so that the rate over time stays at the ceiling.
//
// After a `429`, every request waits for as long as the response asked, or LIMITER_DEFAULT_PAUSE_MS
// when it asked for no time, and never longer than JEV_MAX_RETRY_DELAY_MS: the client stops a
// request that is asked to wait longer, and the others shouldn't wait for longer than that. A
// request whose reserved time falls inside such a pause gives its reservation back when it wakes,
// and reserves again after the pause.
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

// A request's place in the log: when it is, or will be, sent, and until when its tokens count.
interface Entry {
  readonly at: number;
  readonly tokens: number;
  readonly tokensCountUntil: number;
}

export class JevLimiter {
  readonly #limits: JevRateLimits;
  readonly #clock: LimiterClock;
  // Sent and reserved requests, in the order of their send times.
  #log: Entry[] = [];
  #pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(limits: JevRateLimits, clock: LimiterClock = SYSTEM_CLOCK) {
    this.#limits = limits;
    this.#clock = clock;
  }

  /**
   * Resolves true when a request of `tokens`, its estimate, may be sent, and counts it from then
   * on. Resolves false, and gives its place back, once `signal` is aborted. Throws a RangeError
   * for a token count that isn't a whole number from 0, which is a bug in the caller.
   */
  async acquire(tokens: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new RangeError(`tokens is ${tokens}, which isn't a whole number from 0`);
    }
    for (;;) {
      if (signal?.aborted) {
        return false;
      }
      const entry = this.#reserve(tokens);
      const wait = entry.at - this.#clock.now();
      if (wait > 0) {
        await this.#clock.sleep(wait, signal);
      }
      if (signal?.aborted) {
        this.#release(entry);
        return false;
      }
      // A 429 since the reservation: wait for the pause, behind everything reserved so far.
      if (this.#clock.now() < this.#pausedUntil) {
        this.#release(entry);
        continue;
      }
      return true;
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

  // Reserves the earliest send time for a request of `tokens` and logs it, synchronously.
  #reserve(tokens: number): Entry {
    const now = this.#clock.now();
    this.#log = this.#log.filter(
      ({ at, tokensCountUntil }) => at + WINDOW_MS > now || tokensCountUntil > now,
    );
    let at = Math.max(now, this.#pausedUntil, this.#log.at(-1)?.at ?? now);
    for (let wait = this.#waitMs(tokens, at); wait > 0; wait = this.#waitMs(tokens, at)) {
      at += wait;
    }
    const entry: Entry = {
      at,
      tokens,
      tokensCountUntil: at + WINDOW_MS * Math.max(1, tokens / this.#limits.tokensPerSecond),
    };
    this.#log.push(entry);
    return entry;
  }

  #release(entry: Entry): void {
    this.#log = this.#log.filter((other) => other !== entry);
  }

  // How much later than `at` a request of `tokens` has to go, or 0 when it may go at `at`. Every
  // entry in the log is at or before `at`, so only the second that ends at `at` matters.
  #waitMs(tokens: number, at: number): number {
    const waits = [0];
    const { requestsPerSecond, tokensPerSecond } = this.#limits;
    // The requests of the second up to `at`, oldest first, since the log is in that order.
    const recent = this.#log.filter((entry) => entry.at + WINDOW_MS > at);
    if (recent.length >= requestsPerSecond) {
      const oldestInTheWay = recent[recent.length - requestsPerSecond];
      waits.push(oldestInTheWay!.at + WINDOW_MS - at);
    }
    const counting = this.#log
      .filter(({ tokensCountUntil }) => tokensCountUntil > at)
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
      waits.push(entry.tokensCountUntil - at);
    }
    return Math.max(...waits);
  }
}

/**
 * The limiter that search's requests in this isolate share: batched mode's chunks (#211) and pair
 * mode's requests (#213). It holds only numbers, never a request's promise, so a request that is
 * cancelled can't hold up the others (see the module's comment).
 */
export const ISOLATE_JEV_LIMITER = new JevLimiter(SEARCH_JEV_LIMITS);
