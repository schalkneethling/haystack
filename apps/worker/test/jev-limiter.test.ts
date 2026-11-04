// The client-side limiter for search's requests to Jev (#211): it holds Haystack's ceilings for
// requests per second and tokens per second, which #202 left to Haystack's own conservative
// constants, and pauses after a `429`. Time is a fake clock (fake-clock.ts), so no test waits,
// and each records the moment the limiter let every request through. See "Jev model limits" in
// plans/haystack-v1-implementation-plan.md.
import { describe, expect, it } from "vite-plus/test";
import { JEV_MAX_RETRY_DELAY_MS } from "../src/enrichment/jev-client.ts";
import {
  JevLimiter,
  LIMITER_DEFAULT_PAUSE_MS,
  SEARCH_JEV_LIMITS,
} from "../src/search/jev-limiter.ts";
import { JEV_REQUEST_CONTEXT_TOKENS } from "../src/search/search-chunks.ts";
import { type FakeClock, fakeClock } from "./fake-clock.ts";

interface Sent {
  readonly label: string;
  readonly at: number;
  readonly tokens: number;
}

// Asks `limiter` to let each request through at once, in order, and records when each is let
// through. `wait` moves the clock until every request is through.
function send(limiter: JevLimiter, clock: FakeClock, requests: readonly [string, number][]) {
  const sent: Sent[] = [];
  const done = Promise.all(
    requests.map(async ([label, tokens]) => {
      await limiter.acquire(tokens);
      sent.push({ label, at: clock.now(), tokens });
    }),
  );
  return {
    sent,
    async wait(milliseconds = 60_000) {
      await clock.advance(milliseconds);
      await done;
      return sent;
    },
  };
}

// The most requests, and the most tokens, let through in any one second: in the second that
// ends at each request, that request included.
function busiestSecond(sent: readonly Sent[]): { requests: number; tokens: number } {
  let requests = 0;
  let tokens = 0;
  for (const { at } of sent) {
    const inSecond = sent.filter((other) => other.at > at - 1000 && other.at <= at);
    requests = Math.max(requests, inSecond.length);
    tokens = Math.max(
      tokens,
      inSecond.reduce((sum, other) => sum + other.tokens, 0),
    );
  }
  return { requests, tokens };
}

function requests(count: number, tokens: number): [string, number][] {
  return Array.from({ length: count }, (_, index) => [`r${index}`, tokens]);
}

describe("JevLimiter", () => {
  // The account's own limits are deliberately not recorded (#202), so these are Haystack's,
  // below the only figures TypeSafe ever published, 250,000 tokens per second and 1,200 requests
  // a minute for Jev 1.13, and tuned later from real searches.
  it("starts with Haystack's conservative ceilings", () => {
    expect(SEARCH_JEV_LIMITS).toEqual({ requestsPerSecond: 10, tokensPerSecond: 100_000 });
  });

  it("lets no more requests through in a second than the requests-per-second ceiling", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
    const sent = await send(limiter, clock, requests(25, 1)).wait();
    expect(sent).toHaveLength(25);
    expect(busiestSecond(sent).requests).toBe(SEARCH_JEV_LIMITS.requestsPerSecond);
    // Nothing early, and nothing later than it has to be: 10 at once, then the next 10 once the
    // first ones are a second old, and so on.
    expect(sent.map(({ at }) => at)).toEqual([
      ...Array<number>(10).fill(0),
      ...Array<number>(10).fill(1000),
      ...Array<number>(5).fill(2000),
    ]);
  });

  it("lets no more tokens through in a second than the tokens-per-second ceiling", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
    // Five requests of 40,000 tokens: well under the requests ceiling, but 200,000 tokens.
    const sent = await send(limiter, clock, requests(5, 40_000)).wait();
    expect(busiestSecond(sent).requests).toBeLessThan(SEARCH_JEV_LIMITS.requestsPerSecond);
    expect(busiestSecond(sent).tokens).toBeLessThanOrEqual(SEARCH_JEV_LIMITS.tokensPerSecond);
    expect(sent.map(({ at }) => at)).toEqual([0, 0, 1000, 1000, 2000]);
  });

  it("lets a full request of 64k tokens through alone when the second's tokens are spent", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
    const sent = await send(limiter, clock, requests(3, JEV_REQUEST_CONTEXT_TOKENS)).wait();
    expect(sent.map(({ at }) => at)).toEqual([0, 1000, 2000]);
  });

  // The long-context option allows 262,000 tokens in one request, which Phase 11 never sends but
  // Phase 12 may try. Such a request is over the tokens-per-second ceiling by itself, so it can
  // never fit a second's share. It waits until no other request's tokens count, goes alone, and
  // then counts for as many seconds as its tokens need at the ceiling, so the rate over time
  // stays at the ceiling and the request doesn't wait for good.
  it("lets a request larger than a second's tokens through alone, and makes the next one wait for it", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
    const sent = await send(limiter, clock, [
      ["small", 10_000],
      ["long-context", 262_000],
      ["after", 10_000],
    ]).wait();
    expect(sent).toEqual([
      { label: "small", at: 0, tokens: 10_000 },
      { label: "long-context", at: 1000, tokens: 262_000 },
      { label: "after", at: 1000 + 2620, tokens: 10_000 },
    ]);
  });

  // A request that has to wait isn't overtaken by a smaller one that would fit sooner, so a large
  // chunk can't be held back for good by a stream of small ones.
  it("lets requests through in the order they asked", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
    const sent = await send(limiter, clock, [
      ["first", 90_000],
      ["large", 50_000],
      ["small", 1000],
    ]).wait();
    expect(sent.map(({ label, at }) => [label, at])).toEqual([
      ["first", 0],
      ["large", 1000],
      ["small", 1000],
    ]);
  });

  describe("after a 429", () => {
    it.each([
      ["the wait the response asked for", 3000, 3000],
      ["a second, when it asked for none", undefined, LIMITER_DEFAULT_PAUSE_MS],
      ["no longer than the client would wait to retry", 60_000, JEV_MAX_RETRY_DELAY_MS],
    ])("holds every request for %s", async (_, retryAfterMs, pause) => {
      const clock = fakeClock();
      const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
      limiter.throttled(retryAfterMs);
      const sent = await send(limiter, clock, requests(2, 1)).wait();
      expect(sent.map(({ at }) => at)).toEqual([pause, pause]);
    });

    it("keeps the longer pause when a shorter one follows", async () => {
      const clock = fakeClock();
      const limiter = new JevLimiter(SEARCH_JEV_LIMITS, clock);
      limiter.throttled(4000);
      limiter.throttled(1000);
      const sent = await send(limiter, clock, requests(1, 1)).wait();
      expect(sent.map(({ at }) => at)).toEqual([4000]);
    });
  });

  it("lets nothing through for an aborted wait, and doesn't count it", async () => {
    const clock = fakeClock();
    const limiter = new JevLimiter({ requestsPerSecond: 1, tokensPerSecond: 100_000 }, clock);
    expect(await limiter.acquire(1)).toBe(true);
    const controller = new AbortController();
    const aborted = limiter.acquire(1, controller.signal);
    await clock.advance(100);
    controller.abort();
    expect(await aborted).toBe(false);
    // The aborted request gave its place back, so a request that asks after it goes as soon as
    // the first is a second old.
    expect(await send(limiter, clock, [["after", 1]]).wait()).toEqual([
      { label: "after", at: 1000, tokens: 1 },
    ]);
  });

  // Cloudflare can cancel a request's pending work when its client disconnects, and a cancelled
  // request's timer never fires, so it never comes back to the limiter. The limiter is the
  // isolate's, shared by every search, so a request that never comes back mustn't hold up the
  // ones after it. Here the clock's first sleep never wakes, which is that request's timer.
  describe("when a request never comes back", () => {
    // `clock`, except that its first sleep never wakes.
    function losingFirstSleep(clock: FakeClock): FakeClock {
      let lost = false;
      return {
        ...clock,
        sleep: (milliseconds, signal) => {
          if (!lost) {
            lost = true;
            return new Promise<void>(() => {
              // Never settles, as a cancelled request's timer never fires.
            });
          }
          return clock.sleep(milliseconds, signal);
        },
      };
    }

    it.each([
      ["at the head of the line", ["lost", "next"]],
      ["waiting behind another", ["first", "lost", "next"]],
    ])("still lets the next one through on time when it is %s", async (_, line) => {
      const clock = fakeClock();
      const limiter = new JevLimiter(
        { requestsPerSecond: 1, tokensPerSecond: 100_000 },
        losingFirstSleep(clock),
      );
      // A 429 makes the head wait too, so that its sleep is the first.
      if (line[0] === "lost") {
        limiter.throttled(1000);
      }
      const admitted: Record<string, number> = {};
      for (const label of line) {
        void limiter.acquire(1).then(() => {
          admitted[label] = clock.now();
        });
      }
      await clock.advance(10_000);
      // One request a second, and the lost one keeps its second, so the next one goes a second
      // after it would have, and never waits for good.
      expect(admitted.next).toBe(2000);
      expect(admitted.lost).toBeUndefined();
    });
  });

  it("refuses a token count that isn't a whole number from 0", async () => {
    const limiter = new JevLimiter(SEARCH_JEV_LIMITS, fakeClock());
    for (const tokens of [-1, 0.5, Number.NaN]) {
      await expect(limiter.acquire(tokens)).rejects.toThrow(RangeError);
    }
  });
});
