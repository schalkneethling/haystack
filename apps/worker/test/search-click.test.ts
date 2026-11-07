// POST /api/search/click (#215): the search page records that a person followed a result, by
// setting `clicked` on that run's answer for that bookmark, as a weak relevance label for Phase 12.
// The tests send requests to the Worker, as `navigator.sendBeacon` does from the page: the body is
// JSON, but the request has `Accept: */*`, as `fetch` sends, and no custom header, so the session
// cookie and the Origin check are the only things that tell who sent it and from where. The last
// tests call the route's function in this process with a fake context, to show what it gives
// `waitUntil` and what it logs. See "Search page" and "Deleting bookmarks" in plans/haystack-v1-implementation-plan.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDb } from "../src/db/client.ts";
import { postSearchClick } from "../src/search-click.ts";
import { seedBookmark, seedSearchAnswer, seedSearchRun, seedSignedInUser } from "./seed.ts";
import type { SeededUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
});

let origin: string;
let owner: SeededUser;
let other: SeededUser;

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  const DB = await d1();
  // Runs first: a user who has runs can't be deleted, and deleting a run deletes its answers.
  await DB.batch([
    DB.prepare("DELETE FROM search_runs"),
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
  other = await seedSignedInUser(DB, "second@example.com");
});

let seededRuns = 0;

/** A run of the user's with an answer for each of two bookmarks, none of them clicked. */
async function seedRun(user: SeededUser) {
  seededRuns += 1;
  const DB = await d1();
  const runId = await seedSearchRun(DB, user.userId);
  const ids: string[] = [];
  for (const name of ["first", "second"]) {
    const url = `https://example.com/${user.userId}/${seededRuns}/${name}`;
    const bookmarkId = await seedBookmark(DB, user.userId, url, url);
    await seedSearchAnswer(DB, runId, bookmarkId);
    ids.push(bookmarkId);
  }
  const [first, second] = ids;
  if (first === undefined || second === undefined) {
    throw new Error("Two bookmarks were seeded");
  }
  return { runId, first, second };
}

/** Every answer's `clicked`, by run and bookmark, so a test can show what changed and what did not. */
async function clickedAnswers(): Promise<Record<string, number>> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT search_run_id, bookmark_id, clicked FROM search_answers")
    .all();
  return Object.fromEntries(
    results.map((row: Record<string, unknown>) => [
      `${String(row.search_run_id)}/${String(row.bookmark_id)}`,
      Number(row.clicked),
    ]),
  );
}

/**
 * What `navigator.sendBeacon(path, new Blob([body], { type: "application/json" }))` sends: a POST
 * with the cookie, an Origin header, that content type, and no other header of the page's own.
 */
function beacon(headers: Record<string, string>, body: unknown) {
  return server.fetch("/api/search/click", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
}

function clickAsOwner(body: unknown, extra: Record<string, string> = {}) {
  return beacon({ origin, cookie: owner.cookie, ...extra }, body);
}

describe("POST /api/search/click", () => {
  it("sets clicked for that answer and no other", async () => {
    const mine = await seedRun(owner);
    const another = await seedRun(owner);

    const response = await clickAsOwner({ runId: mine.runId, bookmarkId: mine.first });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await clickedAnswers()).toEqual({
      [`${mine.runId}/${mine.first}`]: 1,
      [`${mine.runId}/${mine.second}`]: 0,
      [`${another.runId}/${another.first}`]: 0,
      [`${another.runId}/${another.second}`]: 0,
    });
  });

  it("leaves clicked at 1 when the same result is followed again", async () => {
    const { runId, first } = await seedRun(owner);

    const answers = [
      await clickAsOwner({ runId, bookmarkId: first }),
      await clickAsOwner({ runId, bookmarkId: first }),
    ];

    expect(answers.map(({ status }) => status)).toEqual([204, 204]);
    expect((await clickedAnswers())[`${runId}/${first}`]).toBe(1);
  });

  it("takes the body's text as JSON whatever its content type, as a beacon of a string sends it", async () => {
    const { runId, first } = await seedRun(owner);

    const response = await clickAsOwner(JSON.stringify({ runId, bookmarkId: first }), {
      "content-type": "text/plain;charset=UTF-8",
    });

    expect(response.status).toBe(204);
    expect((await clickedAnswers())[`${runId}/${first}`]).toBe(1);
  });

  it("takes the user from the session, never from the body", async () => {
    const theirs = await seedRun(other);

    const response = await clickAsOwner({
      runId: theirs.runId,
      bookmarkId: theirs.first,
      userId: other.userId,
    });

    expect(response.status).toBe(404);
    expect(await clickedAnswers()).toEqual({
      [`${theirs.runId}/${theirs.first}`]: 0,
      [`${theirs.runId}/${theirs.second}`]: 0,
    });
  });

  describe("answers 404 and changes nothing for", () => {
    it("another user's run, with the same answer as a run that doesn't exist, so it reveals nothing", async () => {
      const theirs = await seedRun(other);

      const response = await clickAsOwner({ runId: theirs.runId, bookmarkId: theirs.first });
      const unknown = await clickAsOwner({ runId: crypto.randomUUID(), bookmarkId: theirs.first });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "SEARCH_ANSWER_NOT_FOUND" });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ code: "SEARCH_ANSWER_NOT_FOUND" });
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it("a run that is the user's, with a bookmark of another user's run", async () => {
      const mine = await seedRun(owner);
      const theirs = await seedRun(other);

      const response = await clickAsOwner({ runId: mine.runId, bookmarkId: theirs.first });

      expect(response.status).toBe(404);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0, 0, 0]);
    });

    it("a bookmark that was not in the run, even one the user saved", async () => {
      const { runId } = await seedRun(owner);
      const DB = await d1();
      const saved = await seedBookmark(DB, owner.userId, "https://example.com/not-found", "x");

      const response = await clickAsOwner({ runId, bookmarkId: saved });

      expect(response.status).toBe(404);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it("an answer that the page never showed, because it was below the thresholds", async () => {
      const { runId, first, second } = await seedRun(owner);
      await (
        await d1()
      )
        .prepare("UPDATE search_answers SET shown = 0 WHERE search_run_id = ? AND bookmark_id = ?")
        .bind(runId, first)
        .run();

      const hidden = await clickAsOwner({ runId, bookmarkId: first });
      const shown = await clickAsOwner({ runId, bookmarkId: second });

      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ code: "SEARCH_ANSWER_NOT_FOUND" });
      expect(shown.status).toBe(204);
      expect(await clickedAnswers()).toEqual({
        [`${runId}/${first}`]: 0,
        [`${runId}/${second}`]: 1,
      });
    });

    it("a deleted bookmark, whose answers were deleted with it", async () => {
      const { runId, first, second } = await seedRun(owner);
      await (await d1()).prepare("DELETE FROM bookmarks WHERE id = ?").bind(first).run();

      const response = await clickAsOwner({ runId, bookmarkId: first });

      expect(response.status).toBe(404);
      expect(await clickedAnswers()).toEqual({ [`${runId}/${second}`]: 0 });
    });

    it("a run that doesn't exist", async () => {
      const { runId, first } = await seedRun(owner);

      const response = await clickAsOwner({ runId: crypto.randomUUID(), bookmarkId: first });

      expect(response.status).toBe(404);
      expect((await clickedAnswers())[`${runId}/${first}`]).toBe(0);
    });
  });

  describe("refuses", () => {
    it("a request without a session with 401, as a script's request, and clicks nothing", async () => {
      const { runId, first } = await seedRun(owner);

      // sendBeacon sends `Accept: */*`, as fetch does, which has no text/html, so the Worker
      // does not take it for a page request.
      const answer = await beacon({ origin }, { runId, bookmarkId: first });
      expect(answer.status).toBe(401);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it("a request with a session that has ended with 401", async () => {
      const { runId, first } = await seedRun(owner);
      await (await d1()).prepare("DELETE FROM sessions").run();

      const answer = await clickAsOwner({ runId, bookmarkId: first });

      expect(answer.status).toBe(401);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it.each([
      ["another origin", { origin: "https://evil.example" }],
      ["an opaque origin", { origin: "null" }],
    ])("a request from %s with 403, with the session's cookie", async (_, headers) => {
      const { runId, first } = await seedRun(owner);

      const answer = await beacon(
        { cookie: owner.cookie, ...headers },
        { runId, bookmarkId: first },
      );

      expect(answer.status).toBe(403);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it("a request with no Origin header with 403", async () => {
      const { runId, first } = await seedRun(owner);

      const answer = await beacon({ cookie: owner.cookie }, { runId, bookmarkId: first });

      expect(answer.status).toBe(403);
      expect(Object.values(await clickedAnswers())).toEqual([0, 0]);
    });

    it("a GET with 404, because the route takes POST only", async () => {
      const response = await server.fetch("/api/search/click", {
        headers: { origin, cookie: owner.cookie },
        redirect: "manual",
      });
      expect(response.status).toBe(404);
    });

    it.each([
      ["a body that is not JSON", "not json"],
      ["an empty body", ""],
      ["a body that is not an object", "[]"],
      ["a missing bookmark", { runId: "run-1" }],
      ["an ID that is not a string", { runId: 1, bookmarkId: "b" }],
      ["an ID of another shape", { runId: "run 1", bookmarkId: "b" }],
    ])("%s with 400", async (_, body) => {
      const answer = await clickAsOwner(body);
      expect(answer.status).toBe(400);
      expect(Object.keys((await answer.json()) as object)).toEqual(["code"]);
    });

    it("a body over 1 KiB with 413", async () => {
      const answer = await clickAsOwner({ runId: "a", bookmarkId: "b".repeat(2048) });
      expect(answer.status).toBe(413);
      expect(await answer.json()).toEqual({ code: "SEARCH_CLICK_TOO_LARGE" });
    });
  });
});

describe("postSearchClick, called in this process", () => {
  it("gives the update to waitUntil, so a page that closes right after the click doesn't cancel it", async () => {
    const { runId, first } = await seedRun(owner);
    const registered: Promise<unknown>[] = [];
    const context = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        registered.push(promise);
      }),
    };

    const response = await postSearchClick(
      new Request("https://haystack.test/api/search/click", {
        method: "POST",
        body: JSON.stringify({ runId, bookmarkId: first }),
      }),
      context,
      createDb(await d1()),
      owner.userId,
    );

    expect(response.status).toBe(204);
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
    // What was registered is the update itself, which answers with the row it marked, so a
    // registration of anything else, or of a promise that is not the update, fails here.
    await expect(registered[0]).resolves.toEqual({ bookmarkId: first });
    expect((await clickedAnswers())[`${runId}/${first}`]).toBe(1);
  });

  // `.get()` starts the query at once and returns a promise, so the one query serves both
  // `waitUntil` and the answer. The test holds the route to that.
  it("runs one statement, though the update is given to waitUntil and awaited", async () => {
    const { runId, first } = await seedRun(owner);
    const DB = await d1();
    const prepared: string[] = [];
    const counting = new Proxy(DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            prepared.push(sql);
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const response = await postSearchClick(
      new Request("https://haystack.test/api/search/click", {
        method: "POST",
        body: JSON.stringify({ runId, bookmarkId: first }),
      }),
      { waitUntil: () => {} },
      createDb(counting),
      owner.userId,
    );

    expect(response.status).toBe(204);
    expect(prepared).toHaveLength(1);
  });

  /**
   * The database, but every statement fails when it runs, as a D1 failure does, with a message no
   * log may hold. Preparing and binding succeed, so the failure arrives as the update's rejection.
   * `whileRunning` is called as the statement runs, before it fails.
   */
  async function failingDb(whileRunning: () => void = () => {}) {
    const DB = await d1();
    const fail = async () => {
      whileRunning();
      throw Object.assign(new Error("secret detail"), { code: "D1_ERROR" });
    };
    const statement = { all: fail, raw: fail, run: fail, first: fail };
    const failing = new Proxy(DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return () => ({ ...statement, bind: () => statement });
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return createDb(failing);
  }

  function fakeContext() {
    const registered: Promise<unknown>[] = [];
    return {
      registered,
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        registered.push(promise);
      }),
    };
  }

  // When the page has gone, the handler may be cancelled before it rethrows to the entry point,
  // which is the only code that logs, so the update given to waitUntil logs the failure, by its
  // code only, and the handler answers 499 instead of throwing, so the failure is logged once.
  it("logs the code of a failed update when the page has gone, and answers 499 instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runId, first } = await seedRun(owner);
    const page = new AbortController();
    const context = fakeContext();

    const handling = postSearchClick(
      new Request("https://haystack.test/api/search/click", {
        method: "POST",
        body: JSON.stringify({ runId, bookmarkId: first }),
        signal: page.signal,
      }),
      context,
      // The page goes while the update runs, as when the tab is closed right after the click.
      await failingDb(() => page.abort()),
      owner.userId,
    );
    // Only what waitUntil holds is awaited, as for a cancelled handler.
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    await context.registered[0];
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Search click failed after the page left:",
      expect.any(String),
    );
    // Drizzle wraps D1's error in its own, whose message holds the statement and whose fields hold
    // the IDs it was given, so the log holds what `errorCode` gives and nothing of either.
    const logged = JSON.stringify(error.mock.calls);
    for (const secret of ["secret detail", "search_answers", runId, first, owner.userId]) {
      expect(logged).not.toContain(secret);
    }
    expect((await handling).status).toBe(499);
    error.mockRestore();
  });

  // The entry point logs a failure that reaches it, so the update given to waitUntil must not
  // log it too.
  it("does not log a failed update itself while the page is connected, and rethrows it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runId, first } = await seedRun(owner);
    const context = fakeContext();

    const handling = postSearchClick(
      new Request("https://haystack.test/api/search/click", {
        method: "POST",
        body: JSON.stringify({ runId, bookmarkId: first }),
      }),
      context,
      await failingDb(),
      owner.userId,
    );
    // The handler's rejection is watched from the start, as the entry point watches it.
    const handled = expect(handling).rejects.toMatchObject({ cause: { code: "D1_ERROR" } });
    await vi.waitFor(() => expect(context.waitUntil).toHaveBeenCalledTimes(1));
    await expect(context.registered[0]).resolves.toBeUndefined();
    await handled;
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
