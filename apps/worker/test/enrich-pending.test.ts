// The enrichment sweep (#127): which bookmarks a run selects, how it runs and stops, its pause on
// GitHub, the `match_text` refresh and its summary, against the real local D1 from Wrangler's test
// harness. Every outside request is answered by the enrichment fixtures (enrichment-fixtures.ts),
// which fail a test that makes a request they did not plan for. See "Enrichment sweep", Phase 8
// and Q3 in plans/haystack-v1-implementation-plan.md. The scheduled handler, the Cron Trigger and
// the configuration module are #128's.
import { and, eq, sql } from "drizzle-orm";
import { HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { createDb, type Db } from "../src/db/client.ts";
import { enrichmentFailures, enrichments } from "../src/db/schema.ts";
import type { EnrichmentConfig, EnrichmentTiming } from "../src/enrichment/enrich-bookmark.ts";
import {
  backoffWindowSql,
  DEFAULT_ATTEMPT_LIMIT,
  enrichPending,
  OUTAGE_STOP_CALLS,
  type SelectionPolicy,
  selectBookmarksToEnrich,
  SWEEP_BATCH_SIZE,
  SWEEP_BATCH_SIZE_LIMIT,
  SWEEP_CONCURRENCY,
  type SweepOptions,
  type SweepSummary,
} from "../src/enrichment/enrich-pending.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import { GitHubPause } from "../src/enrichment/github-pause.ts";
import { MATCH_TEXT_REFRESH_LIMIT } from "../src/enrichment/match-text-refresh.ts";
import { deriveMatchText, MATCH_TEXT_VERSION } from "../src/enrichment/match-text.ts";
import { readEnrichmentStateInputs } from "../src/enrichment/state-inputs.ts";
import {
  backoffWindowMs,
  deriveEnrichmentState,
  readSensitiveWarnThreshold,
} from "../src/enrichment/state.ts";
import {
  ANTHROPIC_ORIGIN,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_ORIGIN,
  output,
  status as llmStatus,
} from "./anthropic-fixture.ts";
import { type EnrichmentFixtures, startEnrichmentFixtures } from "./enrichment-fixtures.ts";
import { VALID_OUTPUT } from "./enrichment-output.ts";
import {
  GITHUB_ORIGIN,
  json as githubJson,
  readme,
  status as githubStatus,
} from "./github-fixture.ts";
import { kind, noul } from "./jev-answers.ts";
import { JEV_ORIGIN, status as jevStatus } from "./jev-fixture.ts";
import {
  seedBookmark,
  seedEnrichment,
  seedEnrichmentFailure,
  type SeededBookmarkFields,
  seedSignedInUser,
} from "./seed.ts";

const server = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});

let fixtures: EnrichmentFixtures;
let db: Db;
let config: EnrichmentConfig;
let threshold: number;
let userId: string;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

// Long enough for the local D1 and MSW under load, and a backoff that doesn't slow the tests.
const timing: EnrichmentTiming = {
  jev: { attemptTimeoutMs: 2000, backoffInitialMs: 1 },
  github: { requestTimeoutMs: 2000 },
  provider: { requestTimeoutMs: 2000 },
};

// A schema version before the current one, as enrichments and failure records have after
// ENRICHMENT_SCHEMA_VERSION is raised.
const OLDER_VERSION = ENRICHMENT_SCHEMA_VERSION - 1;

const HOUR = 60 * 60 * 1000;

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  db = createDb(env.DB);
  // The threshold from wrangler.jsonc, as in enrich-bookmark.test.ts. The secrets aren't bound in
  // the harness, so the tests set their own.
  const SENSITIVE_WARN_THRESHOLD: string = env.SENSITIVE_WARN_THRESHOLD;
  threshold = readSensitiveWarnThreshold({ SENSITIVE_WARN_THRESHOLD });
  config = {
    SENSITIVE_WARN_THRESHOLD,
    JEV_BASE_URL: JEV_ORIGIN,
    JEV_MODEL: "jev-1.13.0",
    TYPESAFE_API_KEY: "ts-test-key-7f3a9c1e",
    GITHUB_API_BASE_URL: GITHUB_ORIGIN,
    GITHUB_TOKEN: "github_pat_test_4d9e2b7a",
    ENRICHMENT_PROVIDER: "ai-gateway",
    ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN,
    ANTHROPIC_MODEL: "claude-haiku-5-5",
    ANTHROPIC_API_KEY: "sk-ant-test-key-4d81b0c2",
    AI_GATEWAY_BASE_URL: GATEWAY_ORIGIN,
    AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT_ID,
    AI_GATEWAY_ID: GATEWAY_ID,
    AI_GATEWAY_TOKEN: "cf-aig-test-token-9e17a6d3",
  };
  fixtures = startEnrichmentFixtures();
});

afterAll(async () => {
  fixtures.close();
  await server.close();
});

beforeEach(async () => {
  fixtures.reset();
  misrouted.length = 0;
  const DB = await d1();
  // Enrichments and failure records go with their bookmarks.
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  ({ userId } = await seedSignedInUser(DB, "owner@example.com"));
  // The sweep logs its summary and its errors. The tests read them, and keep them out of the
  // test output.
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // No test makes a request that the fixtures didn't plan for, so none reaches the network.
  expect(fixtures.unplanned).toEqual([]);
  expect(misrouted).toEqual([]);
});

type Resolver = (request: Request) => Response | Promise<Response>;

// Requests that byBookmark had no answer for.
const misrouted: string[] = [];

/**
 * Answers requests by the bookmark each is about. With several bookmarks under way at once, a
 * service's requests arrive in any order, so one queue can't say which answer is whose. Each
 * request takes the next answer from the queue of the first key that its address or body holds,
 * such as the bookmark's host or repository. Returns one resolver for each answer, for a
 * fixture's `respond`.
 */
function byBookmark(queues: Record<string, Resolver[]>): Resolver[] {
  const total = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
  const route: Resolver = async (request) => {
    const text = `${request.url}\n${await request.clone().text()}`;
    const key = Object.keys(queues).find((candidate) => text.includes(candidate));
    const next = key === undefined ? undefined : queues[key]?.shift();
    if (next === undefined) {
      misrouted.push(request.url);
      return HttpResponse.error();
    }
    return next(request);
  };
  return Array.from({ length: total }, () => route);
}

// Three bookmarks that aren't on GitHub, whose hosts tell their requests apart.
const HOSTS = ["one.example", "two.example", "three.example"] as const;

// GitHub repositories, whose paths tell their requests apart. No name is part of another.
const REPOSITORIES = ["vitest-dev/vitest", "honojs/hono", "drizzle-team/drizzle-orm"] as const;

// What GitHub says about each.
const REPOSITORY = {
  private: false,
  visibility: "public",
  description: "A repository.",
  language: "TypeScript",
  topics: ["test"],
};

// A start time an hour back, so that bookmarks seeded a second apart are oldest first in the order
// a test lists them.
function createdAt(index: number): number {
  return Date.now() - HOUR + index * 1000;
}

async function save(url: string, fields: SeededBookmarkFields = {}): Promise<string> {
  return seedBookmark(await d1(), userId, url, url, fields);
}

// One bookmark for each host, oldest first, with the fields given.
async function saveHosts(count: number, fields: SeededBookmarkFields = {}): Promise<string[]> {
  const ids = [];
  for (const [index, host] of HOSTS.slice(0, count).entries()) {
    ids.push(await save(`https://${host}/post`, { createdAt: createdAt(index), ...fields }));
  }
  return ids;
}

// One bookmark for each repository, oldest first, with the fields given.
async function saveRepositories(fields: SeededBookmarkFields = {}): Promise<string[]> {
  const ids = [];
  for (const [index, repository] of REPOSITORIES.entries()) {
    ids.push(
      await save(`https://github.com/${repository}`, { createdAt: createdAt(index), ...fields }),
    );
  }
  return ids;
}

async function sweep(options: SweepOptions = {}): Promise<SweepSummary> {
  return enrichPending(db, config, { timing, ...options });
}

async function failureRecord(id: string, schemaVersion = ENRICHMENT_SCHEMA_VERSION) {
  return db
    .select()
    .from(enrichmentFailures)
    .where(
      and(
        eq(enrichmentFailures.bookmarkId, id),
        eq(enrichmentFailures.schemaVersion, schemaVersion),
      ),
    )
    .get();
}

async function enrichmentRows(id: string) {
  return db
    .select()
    .from(enrichments)
    .where(eq(enrichments.bookmarkId, id))
    .orderBy(enrichments.schemaVersion)
    .all();
}

async function derivedState(id: string) {
  const inputs = (await readEnrichmentStateInputs(db, userId, ENRICHMENT_SCHEMA_VERSION)).find(
    (bookmark) => bookmark.bookmarkId === id,
  );
  if (inputs === undefined) {
    throw new Error("No such bookmark");
  }
  return deriveEnrichmentState(inputs, {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    sensitiveWarnThreshold: threshold,
    attemptLimit: DEFAULT_ATTEMPT_LIMIT,
  });
}

// Every request any fixture answered, as its address and body, to look for one bookmark's.
function requestTexts(): string[] {
  return [
    ...fixtures.jev.requests.map(({ url, body }) => `${url}\n${body}`),
    ...fixtures.github.requests.map(({ url }) => url),
    ...fixtures.llm.requests.map(({ url, body }) => `${url}\n${body}`),
  ];
}

function requestsAbout(key: string): number {
  return requestTexts().filter((text) => text.includes(key)).length;
}

/**
 * What the sweep logged as errors. Each must be a plain object, which a log shows field by field,
 * and not the Error itself, whose message and stack a log would show too. Vitest's equality alone
 * can't tell them apart, because it matches an Error that has a `code` against `{ code }`.
 */
function loggedErrors(): unknown[] {
  return error.mock.calls.map(([label, logged]: unknown[]) => {
    expect(label).toBe("Enrichment sweep error:");
    expect(Object.getPrototypeOf(logged)).toBe(Object.prototype);
    return logged;
  });
}

// A prototype's own method, as it is before a spy replaces it.
function original<Owner extends object, Key extends keyof Owner>(
  owner: Owner,
  key: Key,
): Owner[Key] {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) {
    throw new Error(`No method ${String(key)}`);
  }
  return descriptor.value as Owner[Key];
}

/** A promise, and the function that resolves it, for a fixture answer that waits on the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolveWith) => {
    resolve = resolveWith;
  });
  return { promise, resolve };
}

/**
 * Resolves once the sweep has stopped its run, so a fixture can answer only then. The run's
 * controller is the sweep's own, so this watches every AbortController for an abort whose reason
 * is the sweep's: an outage's error, the error that was thrown, or a rejected account's. Aborts
 * for other reasons, such as a DOMException from fetch, are left alone.
 */
function whenRunStops(): Promise<void> {
  const stopped = deferred();
  // The method itself, which the spy calls, read before the spy replaces it.
  const abort = original(AbortController.prototype, "abort");
  vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (
    this: AbortController,
    reason?: unknown,
  ) {
    abort.call(this, reason);
    if (reason instanceof Error && !(reason instanceof DOMException)) {
      stopped.resolve();
    }
  });
  return stopped.promise;
}

/** Resolves once the run's bookmarks have asked its pause on GitHub `count` times in all. */
function whenGitHubAsked(count: number): Promise<void> {
  const asked = deferred();
  const read = original(GitHubPause.prototype, "read");
  let calls = 0;
  vi.spyOn(GitHubPause.prototype, "read").mockImplementation(function (
    this: GitHubPause,
    ...args: Parameters<GitHubPause["read"]>
  ) {
    calls += 1;
    if (calls === count) {
      asked.resolve();
    }
    return read.apply(this, args);
  });
  return asked.promise;
}

// The `kind` question's state of each request that asked it.
function kindStates(): { github?: unknown }[] {
  return fixtures.jev.requests
    .map(({ body }) => JSON.parse(body) as { questions: object; state: { github?: unknown } })
    .filter(({ questions }) => "kind" in questions)
    .map(({ state }) => state);
}

const EMPTY_SUMMARY: SweepSummary = {
  selected: 0,
  enriched: 0,
  held: 0,
  failed: 0,
  unfinished: 0,
  moreOutstanding: false,
  refreshed: 0,
  unreadable: 0,
  githubPaused: false,
  stopped: null,
};

describe("selectBookmarksToEnrich", () => {
  // The selection has no ceiling of its own: enrichPending refuses a batch above Q3's.
  async function select(policy: Partial<SelectionPolicy> = {}) {
    const selection = await selectBookmarksToEnrich(db, {
      batchSize: 20,
      attemptLimit: DEFAULT_ATTEMPT_LIMIT,
      sensitiveWarnThreshold: threshold,
      now: Date.now(),
      ...policy,
    });
    return { ...selection, ids: selection.bookmarks.map(({ id }) => id) };
  }

  it("selects only Pending and Outdated bookmarks, of every user, oldest first", async () => {
    const DB = await d1();
    const other = await seedSignedInUser(DB, "other@example.com");
    let index = 0;
    const next = (url: string, fields: SeededBookmarkFields = {}, owner = userId) =>
      seedBookmark(DB, owner, url, url, { createdAt: createdAt((index += 1)), ...fields });

    const pending = await next("https://example.com/pending");
    const outdated = await next("https://example.com/outdated", {}, other.userId);
    await seedEnrichment(DB, outdated, OLDER_VERSION);
    const current = await next("https://example.com/current");
    await seedEnrichment(DB, current, ENRICHMENT_SCHEMA_VERSION);
    // Another run enriched it after this one's failure, so the enrichment decides (#126).
    const currentWithFailure = await next("https://example.com/current-with-failure");
    await seedEnrichment(DB, currentWithFailure, ENRICHMENT_SCHEMA_VERSION);
    await seedEnrichmentFailure(DB, currentWithFailure, ENRICHMENT_SCHEMA_VERSION, 3, 3, 0);
    await next("https://example.com/held", { sensitivityNoul: 0.9 });
    const heldOutdated = await next("https://example.com/held-outdated", { sensitivityNoul: 0.9 });
    await seedEnrichment(DB, heldOutdated, OLDER_VERSION);
    // The rule is at or above the threshold.
    await next("https://example.com/at-threshold", { sensitivityNoul: threshold });
    const released = await next("https://example.com/released", {
      sensitivityNoul: 0.9,
      sensitivityAcknowledgedAt: 1_000,
    });
    const failed = await next("https://example.com/failed");
    await seedEnrichmentFailure(DB, failed, ENRICHMENT_SCHEMA_VERSION, 3, 3, 0);
    // Failed, but still searchable through its older enrichment.
    const failedOutdated = await next("https://example.com/failed-outdated");
    await seedEnrichment(DB, failedOutdated, OLDER_VERSION);
    await seedEnrichmentFailure(DB, failedOutdated, ENRICHMENT_SCHEMA_VERSION, 3, 3, 0);
    const belowLimit = await next("https://example.com/below-limit");
    await seedEnrichmentFailure(DB, belowLimit, ENRICHMENT_SCHEMA_VERSION, 2, 2, 0);
    // An enrichment at a newer version, after a rollback past a schema version change.
    const newer = await next("https://example.com/newer");
    await seedEnrichment(DB, newer, ENRICHMENT_SCHEMA_VERSION + 1);

    const selection = await select();
    const expected = [pending, outdated, released, belowLimit, newer];
    expect(selection.ids).toEqual(expected);
    expect(selection.moreOutstanding).toBe(false);
    // The query reads one bookmark past the batch, so at a batch of exactly the expected count, a
    // bookmark the SQL let through but the derivation dropped would take an expected one's place,
    // or make more seem outstanding.
    expect(await select({ batchSize: expected.length })).toMatchObject({
      ids: expected,
      moreOutstanding: false,
    });
    expect(await select({ batchSize: expected.length - 1 })).toMatchObject({
      ids: expected.slice(0, -1),
      moreOutstanding: true,
    });
  });

  // The query reads one bookmark past the batch, so a bookmark it left to the code to drop
  // could take every place it reads. A Held bookmark stays Held until someone reviews it.
  it("isn't stopped by Held bookmarks older than every outstanding one", async () => {
    for (let index = 0; index < 4; index += 1) {
      await save(`https://example.com/held-${index}`, {
        sensitivityNoul: 0.9,
        createdAt: createdAt(index),
      });
    }
    const pending = await save("https://example.com/pending", { createdAt: createdAt(9) });
    expect((await select({ batchSize: 1 })).ids).toEqual([pending]);
  });

  it("gives enrichBookmark the bookmark's row, as the module reads it", async () => {
    const fields = {
      title: "A post",
      description: "What the user wrote",
      canonicalUrl: "https://example.com/canonical",
      capturedTitle: "A post - Example",
      capturedDescription: "What the page said",
      ogTitle: "A post, shared",
      ogDescription: "What the page shares",
      ogSiteName: "Example",
      sensitiveCanonicalDropped: false,
      sensitivityNoul: 0.02,
      sensitivityAcknowledgedAt: 1_000,
    };
    const id = await save("https://example.com/post", fields);
    const [bookmark] = (await select()).bookmarks;
    expect(bookmark).toMatchObject({ id, url: "https://example.com/post", ...fields });
  });

  it("fills the batch oldest first, and says whether more are outstanding", async () => {
    const third = await save("https://example.com/third", { createdAt: createdAt(3) });
    const first = await save("https://example.com/first", { createdAt: createdAt(1) });
    await save("https://example.com/fourth", { createdAt: createdAt(4) });
    const second = await save("https://example.com/second", { createdAt: createdAt(2) });
    const selection = await select({ batchSize: 2 });
    expect(selection).toMatchObject({ ids: [first, second], moreOutstanding: true });
    expect(await select({ batchSize: 3 })).toMatchObject({
      ids: [first, second, third],
      moreOutstanding: true,
    });
    expect((await select({ batchSize: 4 })).moreOutstanding).toBe(false);
  });

  // The window is 15 minutes after the first failure in a row, doubling up to 6 hours (#127).
  it("leaves out a bookmark within its backoff window, so it takes no place in the batch", async () => {
    const DB = await d1();
    const now = Date.now();
    const minute = 60 * 1000;
    const failedAgo = async (index: number, failures: number, ago: number) => {
      const id = await save(`https://example.com/${index}`, { createdAt: createdAt(index) });
      await seedEnrichmentFailure(DB, id, ENRICHMENT_SCHEMA_VERSION, 0, failures, now - ago);
      return id;
    };
    await failedAgo(1, 1, 15 * minute - 1);
    const windowEnded = await failedAgo(2, 1, 15 * minute);
    await failedAgo(3, 6, 6 * HOUR - 1);
    const capEnded = await failedAgo(4, 40, 6 * HOUR);
    await failedAgo(5, 3, 59 * minute);
    const fresh = await save("https://example.com/fresh", { createdAt: createdAt(6) });
    const selection = await select({ batchSize: 3, now });
    expect(selection).toMatchObject({
      ids: [windowEnded, capEnded, fresh],
      moreOutstanding: false,
    });
  });

  // The query applies the backoff in SQL, so its window must be backoffWindowMs's.
  it("measures the backoff window in SQL as backoffWindowMs does, at every count", async () => {
    for (const failures of [0, 1, 2, 3, 4, 5, 6, 7, 8, 40]) {
      const row = await db.get<{ ms: number }>(
        sql`SELECT ${backoffWindowSql(sql`${failures}`)} AS ms`,
      );
      expect(row.ms).toBe(backoffWindowMs(failures));
    }
    // A bookmark without a failure record has no count, and no window, as for no failures.
    const none = await db.get<{ ms: number }>(sql`SELECT ${backoffWindowSql(sql`NULL`)} AS ms`);
    expect(none.ms).toBe(backoffWindowMs(0));
  });

  it("selects a bookmark exactly when its window ends, at each count from 1 to 7", async () => {
    const DB = await d1();
    const now = Date.now();
    const ended = [];
    for (let failures = 1; failures <= 7; failures += 1) {
      const window = backoffWindowMs(failures);
      const id = await save(`https://example.com/ended-${failures}`, {
        createdAt: createdAt(failures * 2),
      });
      await seedEnrichmentFailure(DB, id, ENRICHMENT_SCHEMA_VERSION, 0, failures, now - window);
      ended.push(id);
      const waiting = await save(`https://example.com/waiting-${failures}`, {
        createdAt: createdAt(failures * 2 + 1),
      });
      await seedEnrichmentFailure(
        DB,
        waiting,
        ENRICHMENT_SCHEMA_VERSION,
        0,
        failures,
        now - window + 1,
      );
    }
    expect((await select({ now })).ids).toEqual(ended);
  });

  it("leaves out a bookmark at the attempt limit it is given, for the current version", async () => {
    const DB = await d1();
    const id = await save("https://example.com/post");
    await seedEnrichmentFailure(DB, id, ENRICHMENT_SCHEMA_VERSION, 2, 2, 0);
    expect((await select({ attemptLimit: 2 })).ids).toEqual([]);
    expect((await select({ attemptLimit: 3 })).ids).toEqual([id]);
  });
});

describe("enrichPending", () => {
  describe("a run", () => {
    it("counts each outcome in a summary of counts only, and logs it", async () => {
      const secret = "Zx81kQ2mPa9wLr4T";
      const [enriched, held, failed] = await Promise.all(
        HOSTS.map((host, index) =>
          save(`https://${host}/share?token=${secret}`, {
            title: `Title-${host}`,
            createdAt: createdAt(index),
          }),
        ),
      );
      // Within its backoff window, and a fourth that doesn't fit in the batch.
      const waiting = await save("https://waiting.example/post", { createdAt: createdAt(4) });
      await seedEnrichmentFailure(await d1(), waiting, ENRICHMENT_SCHEMA_VERSION, 0, 1);
      await save("https://later.example/post", { createdAt: createdAt(5) });
      fixtures.jev.respond(
        ...byBookmark({
          "one.example": [noul(0.02), kind("article")],
          "two.example": [noul(0.9)],
          "three.example": [noul(0.02), jevStatus(400)],
        }),
      );
      fixtures.llm.respond(...byBookmark({ "one.example": [output(VALID_OUTPUT)] }));

      const summary = await sweep();

      expect(summary).toEqual({
        ...EMPTY_SUMMARY,
        selected: 3,
        enriched: 1,
        held: 1,
        failed: 1,
        moreOutstanding: true,
      });
      expect(await derivedState(enriched ?? "")).toBe("current");
      expect(await derivedState(held ?? "")).toBe("held");
      expect((await failureRecord(failed ?? ""))?.attempts).toBe(1);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith("Enrichment sweep:", summary);
      expect(error).not.toHaveBeenCalled();
      // Counts, the pause's flag, and no reason to stop.
      for (const value of Object.values(summary)) {
        expect(value === null || ["number", "boolean"].includes(typeof value)).toBe(true);
      }
      const logged = JSON.stringify(info.mock.calls);
      for (const leaked of [secret, "example", "Title", "share"]) {
        expect(logged).not.toContain(leaked);
      }
    });

    it.each([
      ["a permanent failure", () => [noul(0.02), jevStatus(400)], () => []],
      ["a transient failure", () => [noul(0.02), kind("article")], () => [llmStatus(529)]],
    ] as const)(
      "doesn't stop the batch for %s of one bookmark",
      async (_, firstJev: () => Resolver[], firstLlm: () => Resolver[]) => {
        const [first, second, third] = await saveHosts(3);
        fixtures.jev.respond(
          ...byBookmark({
            "one.example": firstJev(),
            "two.example": [noul(0.02), kind("article")],
            "three.example": [noul(0.02), kind("article")],
          }),
        );
        fixtures.llm.respond(
          ...byBookmark({
            "one.example": firstLlm(),
            "two.example": [output(VALID_OUTPUT)],
            "three.example": [output(VALID_OUTPUT)],
          }),
        );
        // One at a time, so the failing bookmark is the first to finish.
        expect(await sweep({ concurrency: 1 })).toEqual({
          ...EMPTY_SUMMARY,
          selected: 3,
          enriched: 2,
          failed: 1,
        });
        expect(await failureRecord(first ?? "")).toBeDefined();
        expect(await derivedState(second ?? "")).toBe("current");
        expect(await derivedState(third ?? "")).toBe("current");
      },
    );

    it.each([
      ["2", 2, 2],
      ["Q3's 3, when none is given", undefined, SWEEP_BATCH_SIZE],
    ])("enriches no more bookmarks than a batch size of %s", async (_, batchSize, expected) => {
      expect(SWEEP_BATCH_SIZE).toBe(3);
      const ids = await saveHosts(3);
      const later = await save("https://later.example/post", { createdAt: createdAt(9) });
      // Answers for the bookmarks the batch should hold, and none for the others.
      const chosen = HOSTS.slice(0, expected);
      const queues = (answers: () => Resolver[]) =>
        Object.fromEntries(chosen.map((host) => [host, answers()]));
      fixtures.jev.respond(...byBookmark(queues(() => [noul(0.02), kind("article")])));
      fixtures.llm.respond(...byBookmark(queues(() => [output(VALID_OUTPUT)])));
      const summary = await sweep(batchSize === undefined ? {} : { batchSize });
      expect(summary).toMatchObject({
        selected: expected,
        enriched: expected,
        moreOutstanding: true,
      });
      for (const [index, id] of [...ids, later].entries()) {
        expect(await derivedState(id)).toBe(index < expected ? "current" : "pending");
      }
      expect(requestsAbout("later.example")).toBe(0);
    });

    it.each([
      ["1", 1, 1],
      ["2", 2, 2],
      ["Q3's 3, when none is given", undefined, SWEEP_CONCURRENCY],
    ])(
      "enriches no more bookmarks at once than a concurrency of %s",
      async (_, concurrency, expected) => {
        await saveHosts(3, { sensitivityNoul: 0.02 });
        // A bookmark is under way from its first request, its `kind` question, to its last, the
        // LLM's. The `kind` answers are held until `expected` bookmarks are under way, or every
        // bookmark has started, so the run must have `expected` under way at once to go on. A
        // run that allows fewer never gets there, and the test's own time limit fails it. One
        // that allows more starts another bookmark before the held ones can reach the LLM.
        let underWay = 0;
        let started = 0;
        let most = 0;
        let held = deferred();
        const heldKind: Resolver = async (request) => {
          started += 1;
          underWay += 1;
          most = Math.max(most, underWay);
          const release = held;
          if (underWay === expected || started === 3) {
            held = deferred();
            release.resolve();
          }
          await release.promise;
          return kind("article")(request);
        };
        const lastRequest: Resolver = (request) => {
          underWay -= 1;
          return output(VALID_OUTPUT)(request);
        };
        fixtures.jev.respond(heldKind, heldKind, heldKind);
        fixtures.llm.respond(lastRequest, lastRequest, lastRequest);
        const summary = await sweep(concurrency === undefined ? {} : { concurrency });
        expect(summary).toMatchObject({ selected: 3, enriched: 3 });
        expect(most).toBe(expected);
      },
    );

    it("makes no request when nothing is outstanding, in a second run", async () => {
      await saveHosts(2);
      fixtures.jev.respond(
        ...byBookmark({
          "one.example": [noul(0.02), kind("article")],
          "two.example": [noul(0.02), kind("article")],
        }),
      );
      fixtures.llm.respond(output(VALID_OUTPUT), output(VALID_OUTPUT));
      expect(await sweep()).toMatchObject({ selected: 2, enriched: 2 });
      const requests = requestTexts().length;
      expect(await sweep()).toEqual(EMPTY_SUMMARY);
      expect(requestTexts()).toHaveLength(requests);
    });

    it.each([
      ["4", { batchSize: SWEEP_BATCH_SIZE_LIMIT + 1 }],
      ["0", { batchSize: 0 }],
      ["2.5", { batchSize: 2.5 }],
    ])("refuses a batch size of %s, before anything is read or sent", async (_, options) => {
      await saveHosts(1);
      await expect(sweep(options)).rejects.toBeInstanceOf(RangeError);
      expect(info).not.toHaveBeenCalled();
    });

    it.each([
      ["a concurrency", { concurrency: 0 }],
      ["an attempt limit", { attemptLimit: 0 }],
    ])("refuses %s below 1", async (_, options) => {
      await expect(sweep(options)).rejects.toBeInstanceOf(RangeError);
    });
  });

  describe("selection across schema versions", () => {
    it("enriches a bookmark again after the schema version is raised, and keeps its older enrichment", async () => {
      const id = await save("https://one.example/post", { sensitivityNoul: 0.02 });
      const older = await seedEnrichment(await d1(), id, OLDER_VERSION);
      expect(await derivedState(id)).toBe("outdated");
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await sweep()).toMatchObject({ selected: 1, enriched: 1 });
      // Search uses the most recent enrichment, and the older one is still there.
      const rows = await enrichmentRows(id);
      expect(rows.map(({ id: rowId, schemaVersion }) => ({ rowId, schemaVersion }))).toEqual([
        { rowId: older, schemaVersion: OLDER_VERSION },
        { rowId: expect.any(String), schemaVersion: ENRICHMENT_SCHEMA_VERSION },
      ]);
      expect(await derivedState(id)).toBe("current");
    });

    it("keeps the older enrichment readable while the new one fails", async () => {
      const id = await save("https://one.example/post", { sensitivityNoul: 0.02 });
      const older = await seedEnrichment(await d1(), id, OLDER_VERSION);
      fixtures.jev.respond(jevStatus(400));
      expect(await sweep()).toMatchObject({ selected: 1, failed: 1 });
      expect((await enrichmentRows(id)).map(({ id: rowId }) => rowId)).toEqual([older]);
      expect(await derivedState(id)).toBe("outdated");
    });

    it("starts the attempt count again for a bookmark Failed at the older version", async () => {
      const id = await save("https://one.example/post", { sensitivityNoul: 0.02 });
      await seedEnrichment(await d1(), id, OLDER_VERSION);
      await seedEnrichmentFailure(await d1(), id, OLDER_VERSION, DEFAULT_ATTEMPT_LIMIT, 3, 0);
      fixtures.jev.respond(jevStatus(400));
      expect(await sweep()).toMatchObject({ selected: 1, failed: 1 });
      expect(await failureRecord(id)).toMatchObject({ attempts: 1, consecutiveFailures: 1 });
      expect(await derivedState(id)).toBe("outdated");
    });
  });

  // When the first few calls all fail transiently, the run stops, because an outage affects every
  // bookmark the same way (#127).
  describe("an outage", () => {
    it("stops the run when its first calls all fail transiently, and starts nothing more", async () => {
      expect(OUTAGE_STOP_CALLS).toBe(2);
      const [, , third] = await saveHosts(3, { sensitivityNoul: 0.02 });
      fixtures.jev.respond(kind("article"), kind("article"));
      fixtures.llm.respond(llmStatus(529), llmStatus(529));
      // One at a time, so the third hasn't started when the second fails.
      expect(await sweep({ concurrency: 1 })).toEqual({
        ...EMPTY_SUMMARY,
        selected: 3,
        failed: 2,
        unfinished: 1,
        stopped: "outage",
      });
      expect(requestsAbout("three.example")).toBe(0);
      expect(await failureRecord(third ?? "")).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
    });

    // The third is under way when the first two fail, and its own answer comes after the stop.
    it.each([
      ["records no failure for a bookmark under way", llmStatus(529), { failed: 2, unfinished: 1 }],
      [
        "still stores a bookmark under way whose answer came",
        output(VALID_OUTPUT),
        { enriched: 1, failed: 2 },
      ],
    ])("%s when the run stops", async (_, thirdAnswer, counts) => {
      const [, , third] = await saveHosts(3, { sensitivityNoul: 0.02 });
      fixtures.jev.respond(kind("article"), kind("article"), kind("article"));
      const stopped = whenRunStops();
      // Once both failures are recorded and the run has stopped.
      const late: Resolver = async (request) => {
        await stopped;
        return thirdAnswer(request);
      };
      fixtures.llm.respond(
        ...byBookmark({
          "one.example": [llmStatus(529)],
          "two.example": [llmStatus(529)],
          "three.example": [late],
        }),
      );
      expect(await sweep()).toEqual({
        ...EMPTY_SUMMARY,
        selected: 3,
        ...counts,
        stopped: "outage",
      });
      expect(await failureRecord(third ?? "")).toBeUndefined();
    });
  });

  // A service that rejected Haystack's own account would fail every bookmark the same way, so the
  // run stops and records nothing against any bookmark (#127, the owner's decision).
  describe("a rejected account", () => {
    // Bookmarks that have failed before, outside their backoff window, so a change to a record
    // would show.
    async function saveWithFailures(first: string) {
      const DB = await d1();
      const ids = [
        await save(first, { createdAt: createdAt(0) }),
        await save("https://two.example/post", { createdAt: createdAt(1) }),
        await save("https://three.example/post", { createdAt: createdAt(2) }),
      ];
      const before = [];
      for (const id of ids) {
        await seedEnrichmentFailure(DB, id, ENRICHMENT_SCHEMA_VERSION, 1, 4, Date.now() - 3 * HOUR);
        before.push(await failureRecord(id));
      }
      return { ids, before };
    }

    it.each([
      [
        "Jev's 401",
        "https://one.example/post",
        () => fixtures.jev.respond(jevStatus(401)),
        { step: "sensitivity", reason: "status", status: 401 },
      ],
      [
        "the LLM's 402",
        "https://one.example/post",
        () => {
          fixtures.jev.respond(noul(0.02), kind("article"));
          fixtures.llm.respond(llmStatus(402));
        },
        { step: "llm", reason: "status", status: 402 },
      ],
      [
        "GitHub's 401",
        `https://github.com/${REPOSITORIES[0]}`,
        () => {
          fixtures.jev.respond(noul(0.02));
          fixtures.github.respond(githubStatus(401));
        },
        { step: "github", reason: "unauthorized", status: 401 },
      ],
    ])(
      "stops the run at %s, records nothing, and logs only fixed codes",
      async (_, first, respond, fields) => {
        const { ids, before } = await saveWithFailures(first);
        respond();
        // One at a time, so the others haven't started when the first is rejected.
        expect(await sweep({ concurrency: 1 })).toEqual({
          ...EMPTY_SUMMARY,
          selected: 3,
          unfinished: 3,
          stopped: "account",
        });
        for (const [index, id] of ids.entries()) {
          expect(await failureRecord(id)).toEqual(before[index]);
          expect(await derivedState(id)).toBe("pending");
        }
        expect(requestsAbout("two.example") + requestsAbout("three.example")).toBe(0);
        expect(loggedErrors()).toEqual([{ code: "ENRICHMENT_ACCOUNT_REJECTED", ...fields }]);
      },
    );

    it("records nothing for the bookmarks under way when the account is rejected", async () => {
      const { ids, before } = await saveWithFailures("https://one.example/post");
      const stopped = whenRunStops();
      // The others' sensitivity questions fail transiently, but only once the run has stopped,
      // so the Jev client makes no other attempt at them.
      const lateOutage: Resolver = async (request) => {
        await stopped;
        return jevStatus(503)(request);
      };
      fixtures.jev.respond(
        ...byBookmark({
          "one.example": [jevStatus(401)],
          "two.example": [lateOutage],
          "three.example": [lateOutage],
        }),
      );
      expect(await sweep()).toEqual({
        ...EMPTY_SUMMARY,
        selected: 3,
        unfinished: 3,
        stopped: "account",
      });
      for (const [index, id] of ids.entries()) {
        expect(await failureRecord(id)).toEqual(before[index]);
      }
      // One attempt at each sensitivity question and nothing after them, and the one rejection is
      // logged once.
      expect(fixtures.jev.requests).toHaveLength(3);
      expect(kindStates()).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
    });

    // Their reads wait on the pause alone, not on a request, so only a stop that comes with the
    // 401 itself, rather than when its error reaches the sweep, is in time for them.
    it("sends nothing for the bookmarks waiting their turn at GitHub when GitHub rejects the token", async () => {
      await saveRepositories({ sensitivityNoul: 0.02 });
      // Answered once every bookmark is waiting its turn.
      const allWaiting = whenGitHubAsked(3);
      fixtures.github.respond(async (request) => {
        await allWaiting;
        return githubStatus(401)(request);
      });
      expect(await sweep()).toEqual({
        ...EMPTY_SUMMARY,
        selected: 3,
        unfinished: 3,
        stopped: "account",
      });
      expect(fixtures.github.requests).toHaveLength(1);
      expect(fixtures.jev.requests).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  // A configuration error or a D1 error is the run's problem, not the bookmark's, so it stops the
  // run as a rejected account does, and is logged by its code alone, because a message can hold a
  // value from the configuration.
  describe("any other thrown error", () => {
    it("stops the run at a configuration error, records nothing and logs only its code", async () => {
      const ids = await saveHosts(3);
      const summary = await enrichPending(
        db,
        { ...config, AI_GATEWAY_TOKEN: "" },
        { timing, concurrency: 1 },
      );
      expect(summary).toEqual({ ...EMPTY_SUMMARY, selected: 3, unfinished: 3, stopped: "error" });
      expect(requestTexts()).toEqual([]);
      for (const id of ids) {
        expect(await failureRecord(id)).toBeUndefined();
      }
      expect(loggedErrors()).toEqual([{ code: "AI_GATEWAY_TOKEN_EMPTY" }]);
    });

    it("stops before selecting anything when the threshold can't be read, without its value", async () => {
      await saveHosts(1);
      const summary = await enrichPending(
        db,
        { ...config, SENSITIVE_WARN_THRESHOLD: "high-0.5" },
        { timing },
      );
      expect(summary).toEqual({ ...EMPTY_SUMMARY, stopped: "error" });
      expect(requestTexts()).toEqual([]);
      expect(loggedErrors()).toEqual([{ code: "SENSITIVE_WARN_THRESHOLD_INVALID" }]);
      expect(info).toHaveBeenCalledWith("Enrichment sweep:", summary);
    });
  });

  // GitHub's rate limit is shared by every token on Schalk's account, so after GitHub rate-limits
  // one request, the run asks it nothing more, and still enriches every bookmark (#123, #127).
  describe("the pause on GitHub", () => {
    it.each([
      ["the repository's request", false],
      ["the README's request", true],
    ])(
      "asks GitHub nothing more after a rate limit on %s, and enriches all 3",
      async (_, onReadme) => {
        const ids = await saveRepositories({ sensitivityNoul: 0.02 });
        // Answered once every bookmark has asked to read GitHub, so the other bookmarks' reads
        // would have gone out by then if the run let them through.
        const allAsked = whenGitHubAsked(3);
        const rateLimit: Resolver = async (request) => {
          await allAsked;
          return githubStatus(403, { "x-ratelimit-remaining": "0" })(request);
        };
        const answers = onReadme ? [githubJson(REPOSITORY), rateLimit] : [rateLimit];
        fixtures.github.respond(...answers);
        fixtures.jev.respond(kind(), kind(), kind());
        fixtures.llm.respond(output(VALID_OUTPUT), output(VALID_OUTPUT), output(VALID_OUTPUT));
        expect(await sweep()).toEqual({
          ...EMPTY_SUMMARY,
          selected: 3,
          enriched: 3,
          githubPaused: true,
        });
        // The first read's requests, and nothing after them.
        expect(fixtures.github.requests).toHaveLength(answers.length);
        expect(kindStates().filter((state) => "github" in state)).toHaveLength(onReadme ? 1 : 0);
        for (const id of ids) {
          expect(await derivedState(id)).toBe("current");
        }
      },
    );

    it("goes on asking GitHub after a failure that isn't a rate limit", async () => {
      await saveRepositories({ sensitivityNoul: 0.02 });
      fixtures.github.respond(
        githubStatus(500),
        githubJson(REPOSITORY),
        readme("# Readme"),
        githubJson(REPOSITORY),
        readme("# Readme"),
      );
      fixtures.jev.respond(kind(), kind(), kind());
      fixtures.llm.respond(output(VALID_OUTPUT), output(VALID_OUTPUT), output(VALID_OUTPUT));
      expect(await sweep()).toMatchObject({ enriched: 3, githubPaused: false });
      expect(fixtures.github.requests).toHaveLength(5);
    });
  });

  // Q3 sizes the batch by this case, 3 bookmarks of 10 outside requests each (#118, #119).
  it("makes at most 30 outside requests in Q3's worst case", async () => {
    await saveRepositories();
    // Each Jev question succeeds only on its third attempt.
    const third = (answer: Resolver) => [jevStatus(503), jevStatus(503), answer];
    const invalid = { ...VALID_OUTPUT, summary: "x".repeat(281) };
    const queues = (answers: () => Resolver[]) =>
      Object.fromEntries(REPOSITORIES.map((repository) => [repository, answers()]));
    fixtures.jev.respond(...byBookmark(queues(() => [...third(noul(0.02)), ...third(kind())])));
    fixtures.github.respond(
      ...byBookmark(queues(() => [githubJson(REPOSITORY), readme("# Readme")])),
    );
    fixtures.llm.respond(...byBookmark(queues(() => [output(invalid), output(VALID_OUTPUT)])));
    expect(await sweep()).toEqual({ ...EMPTY_SUMMARY, selected: 3, enriched: 3 });
    expect(requestTexts()).toHaveLength(30);
  });

  // When the derivation changes, MATCH_TEXT_VERSION is raised, and the sweep rewrites each
  // enrichment's text from what is stored, a few each run (#126, #127).
  describe("the match_text refresh", () => {
    const STALE_VERSION = MATCH_TEXT_VERSION - 1;

    // Bookmarks enriched at the current schema version, with text from an older derivation.
    async function saveStale(count: number) {
      const DB = await d1();
      const saved = [];
      for (let index = 0; index < count; index += 1) {
        const title = `Bookmark ${index}`;
        const id = await save(`https://example.com/${index}`, { title, sensitivityNoul: 0.02 });
        const enrichment = await seedEnrichment(DB, id, ENRICHMENT_SCHEMA_VERSION, {
          kind: "tool",
          data: VALID_OUTPUT,
          matchText: "Stale",
          matchTextVersion: STALE_VERSION,
          createdAt: createdAt(index),
        });
        saved.push({ enrichment, title });
      }
      return saved;
    }

    async function matchTextOf(enrichmentId: string) {
      return db
        .select({ matchText: enrichments.matchText, version: enrichments.matchTextVersion })
        .from(enrichments)
        .where(eq(enrichments.id, enrichmentId))
        .get();
    }

    it("rewrites 4 of 6 enrichments in one run, then the other 2, without any request", async () => {
      expect(MATCH_TEXT_REFRESH_LIMIT).toBe(4);
      const saved = await saveStale(6);
      expect(await sweep()).toEqual({ ...EMPTY_SUMMARY, refreshed: 4 });
      for (const [index, { enrichment, title }] of saved.entries()) {
        expect(await matchTextOf(enrichment)).toEqual(
          index < 4
            ? {
                matchText: deriveMatchText({ title, kind: "tool", enrichment: VALID_OUTPUT }),
                version: MATCH_TEXT_VERSION,
              }
            : { matchText: "Stale", version: STALE_VERSION },
        );
      }
      expect(await sweep()).toEqual({ ...EMPTY_SUMMARY, refreshed: 2 });
      for (const { enrichment } of saved) {
        expect((await matchTextOf(enrichment))?.version).toBe(MATCH_TEXT_VERSION);
      }
      expect(await sweep()).toEqual(EMPTY_SUMMARY);
      expect(requestTexts()).toEqual([]);
    });

    it("rewrites a run's enrichments together or not at all", async () => {
      const [first, second] = await saveStale(2);
      const DB = await d1();
      await DB.prepare(
        `CREATE TRIGGER fail_refresh BEFORE UPDATE ON enrichments WHEN OLD.id = '${second?.enrichment}' BEGIN SELECT RAISE(ABORT, 'the rewrite failed'); END`,
      ).run();
      try {
        expect(await sweep()).toEqual({ ...EMPTY_SUMMARY, stopped: "error" });
      } finally {
        await DB.prepare("DROP TRIGGER fail_refresh").run();
      }
      for (const { enrichment } of [first, second]) {
        expect(await matchTextOf(enrichment ?? "")).toEqual({
          matchText: "Stale",
          version: STALE_VERSION,
        });
      }
    });

    it("leaves an enrichment whose stored data can't be read, and counts it", async () => {
      const [readable] = await saveStale(1);
      const id = await save("https://example.com/unreadable", { sensitivityNoul: 0.02 });
      const unreadable = await seedEnrichment(await d1(), id, ENRICHMENT_SCHEMA_VERSION, {
        data: { summary: 42 },
        matchText: "Stale",
        matchTextVersion: STALE_VERSION,
      });
      expect(await sweep()).toEqual({ ...EMPTY_SUMMARY, refreshed: 1, unreadable: 1 });
      expect((await matchTextOf(readable?.enrichment ?? ""))?.version).toBe(MATCH_TEXT_VERSION);
      expect(await matchTextOf(unreadable)).toEqual({ matchText: "Stale", version: STALE_VERSION });
    });

    // Another version's data has its own shape, and its bookmark gets a new enrichment instead.
    it("rewrites only enrichments at the current schema version", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const DB = await d1();
      const older = await seedEnrichment(DB, id, OLDER_VERSION, {
        data: VALID_OUTPUT,
        matchText: "Stale",
        matchTextVersion: STALE_VERSION,
      });
      await seedEnrichment(DB, id, ENRICHMENT_SCHEMA_VERSION, { data: VALID_OUTPUT });
      expect(await sweep()).toEqual(EMPTY_SUMMARY);
      expect(await matchTextOf(older)).toEqual({ matchText: "Stale", version: STALE_VERSION });
    });
  });
});
