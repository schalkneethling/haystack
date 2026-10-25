// A sweep run's pause on GitHub (#127). See "GitHub enrichment" and "Enrichment sweep" in
// plans/haystack-v1-implementation-plan.md. Every token on Schalk's account shares GitHub's rate
// limit, and GitHub warns that continuing to make requests while rate limited can get an
// integration banned. So once GitHub rate-limits a request, the run asks GitHub nothing more, and
// its other bookmarks are enriched without GitHub's data, as after any other GitHub failure.
//
// A run enriches several bookmarks at once, so a pause that took effect only when a bookmark's
// outcome came back would let the other bookmarks' requests through in the meantime. The pause
// therefore lets one bookmark's GitHub read through at a time: a read waits for the one before it,
// and learns whether that one was rate-limited before it sends anything. A read is at most 2
// requests of at most 3 seconds each, and usually far less, so a few in a row cost little of a
// run's 15 minutes of wall time (Q3).
import type { GitHubResult } from "./github-client.ts";

// A rate limit can come in either of a read's two requests: the repository's, which then returns
// no data, or the README's, which still returns the repository's data.
function rateLimited(result: GitHubResult): boolean {
  const failure = result.ok ? result.readmeFailure : result;
  return failure?.reason === "rate-limited";
}

/** One run's GitHub reads, one at a time, with nothing sent after a rate limit. */
export class GitHubPause {
  #paused = false;
  // The read that was let through last, which the next one waits for.
  #previous: Promise<unknown> = Promise.resolve();

  /** Whether GitHub rate-limited a request in this run, so nothing more is asked of it. */
  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Calls `read` once every read before it has finished, and resolves to its result. Resolves to
   * undefined, without calling it, when GitHub rate-limited an earlier read in the run.
   */
  read(read: () => Promise<GitHubResult>): Promise<GitHubResult | undefined> {
    const turn = this.#previous.then(async () => {
      if (this.#paused) {
        return undefined;
      }
      const result = await read();
      if (rateLimited(result)) {
        this.#paused = true;
      }
      return result;
    });
    // The next read waits for this one however it ends, so a read that throws, as one does when
    // the run has stopped, doesn't keep the others waiting.
    this.#previous = turn.catch(() => undefined);
    return turn;
  }
}
