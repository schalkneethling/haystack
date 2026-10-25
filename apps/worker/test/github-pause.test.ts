// A sweep run's pause on GitHub (#127): one read at a time, and nothing sent after GitHub
// rate-limits a request. See "GitHub enrichment" in plans/haystack-v1-implementation-plan.md. The
// reads here are stand-ins that return the GitHub client's results, so nothing is sent.
import { describe, expect, it } from "vite-plus/test";
import type { GitHubResult } from "../src/enrichment/github-client.ts";
import { GitHubPause } from "../src/enrichment/github-pause.ts";

const EVIDENCE = { repository: "vitest-dev/vitest", bookmark_is: "the repository" } as const;

const READ: GitHubResult = { ok: true, evidence: EVIDENCE, requests: 2 };

// A read that resolves when the test says so, and records when it was called.
function heldRead(result: GitHubResult) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = {
    called: false,
    release,
    run: async () => {
      read.called = true;
      await released;
      return result;
    },
  };
  return read;
}

describe("GitHubPause", () => {
  it("lets a read through only once the one before it has finished", async () => {
    const pause = new GitHubPause();
    const first = heldRead(READ);
    const second = heldRead(READ);
    const firstResult = pause.read(first.run);
    const secondResult = pause.read(second.run);
    // Let every pending callback run, so the second read would have started by now if it could.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.called).toBe(true);
    expect(second.called).toBe(false);
    first.release();
    await firstResult;
    second.release();
    expect(await secondResult).toEqual(READ);
    expect(second.called).toBe(true);
  });

  it.each([
    [
      "the repository's request",
      { ok: false, reason: "rate-limited", status: 403, requests: 1 } as const,
    ],
    [
      "the README's request, which still returns the repository's data",
      {
        ok: true,
        evidence: EVIDENCE,
        readmeFailure: { reason: "rate-limited", status: 429 },
        requests: 2,
      } as const,
    ],
  ])("asks nothing more after a rate limit on %s", async (_, limited: GitHubResult) => {
    const pause = new GitHubPause();
    expect(pause.paused).toBe(false);
    expect(await pause.read(async () => limited)).toEqual(limited);
    expect(pause.paused).toBe(true);
    let called = false;
    const later = await pause.read(async () => {
      called = true;
      return READ;
    });
    expect(later).toBeUndefined();
    expect(called).toBe(false);
  });

  // A read that was already waiting when the rate limit came isn't sent either.
  it("doesn't send a read that was waiting when the rate limit came", async () => {
    const pause = new GitHubPause();
    const limited = heldRead({ ok: false, reason: "rate-limited", status: 403, requests: 1 });
    const waiting = heldRead(READ);
    const limitedResult = pause.read(limited.run);
    const waitingResult = pause.read(waiting.run);
    limited.release();
    await limitedResult;
    expect(await waitingResult).toBeUndefined();
    expect(waiting.called).toBe(false);
  });

  it.each([
    ["a missing repository", { ok: false, reason: "not-found", status: 404, requests: 1 } as const],
    ["a server error", { ok: false, reason: "status", status: 500, requests: 1 } as const],
    [
      "a missing README",
      {
        ok: true,
        evidence: EVIDENCE,
        readmeFailure: { reason: "not-found", status: 404 },
        requests: 2,
      } as const,
    ],
  ])("goes on asking after %s", async (_, failure: GitHubResult) => {
    const pause = new GitHubPause();
    await pause.read(async () => failure);
    expect(pause.paused).toBe(false);
    expect(await pause.read(async () => READ)).toEqual(READ);
  });

  it("goes on with the next read after one throws, as one does when the run stops", async () => {
    const pause = new GitHubPause();
    const stopped = new Error("stopped");
    await expect(
      pause.read(async () => {
        throw stopped;
      }),
    ).rejects.toBe(stopped);
    expect(await pause.read(async () => READ)).toEqual(READ);
  });
});
