// A clock that moves only when a test moves it, for the Jev limiter's tests (#211). Nothing waits
// for real time: `advance` wakes each sleeper at its own moment, in order, and lets the code it
// wakes run before it moves on, so the times a test records are the times the limiter chose.
import type { LimiterClock } from "../src/search/jev-limiter.ts";

interface Sleeper {
  readonly wakeAt: number;
  readonly wake: () => void;
}

export interface FakeClock extends LimiterClock {
  /** Moves the clock forward by `milliseconds`, waking every sleeper that is due on the way. */
  advance(milliseconds: number): Promise<void>;
}

// Lets every promise that is ready run, including those that become ready while they run. A
// macrotask runs only once the microtask queue is empty, and no timer is faked here, so this
// waits for no time on the fake clock.
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function fakeClock(start = 0): FakeClock {
  let now = start;
  let sleepers: Sleeper[] = [];
  return {
    now: () => now,
    sleep(milliseconds, signal) {
      return new Promise<void>((resolve) => {
        const sleeper: Sleeper = {
          wakeAt: now + Math.max(0, milliseconds),
          wake: () => {
            sleepers = sleepers.filter((other) => other !== sleeper);
            signal?.removeEventListener("abort", sleeper.wake);
            resolve();
          },
        };
        sleepers.push(sleeper);
        signal?.addEventListener("abort", sleeper.wake, { once: true });
      });
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      await settle();
      for (;;) {
        const next = sleepers
          .filter(({ wakeAt }) => wakeAt <= target)
          .sort((a, b) => a.wakeAt - b.wakeAt)[0];
        if (next === undefined) {
          break;
        }
        now = next.wakeAt;
        next.wake();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
