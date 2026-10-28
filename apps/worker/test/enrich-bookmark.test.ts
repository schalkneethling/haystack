// The enrichment module (#126): one bookmark from the sensitivity gate to its stored enrichment,
// against the real local D1 from Wrangler's test harness. Every outside request is answered by
// the enrichment fixtures (enrichment-fixtures.ts), which fail a test that makes a request they
// did not plan for. See "Enrichment design", "Enrichment sweep", Phase 7 and Q3 in
// plans/haystack-v1-implementation-plan.md.
import { describeUrlForJudgment, detectSensitiveUrl } from "@haystack/schemas";
import { and, eq } from "drizzle-orm";
import { delay, HttpResponse } from "msw";
import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDb, type Db } from "../src/db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../src/db/schema.ts";
import {
  EnrichmentAccountError,
  type EnrichmentConfig,
  type EnrichmentOutcome,
  type EnrichmentTiming,
  enrichBookmark,
  TRANSIENT_FAILURES_PER_ATTEMPT,
} from "../src/enrichment/enrich-bookmark.ts";
import { DEFAULT_ATTEMPT_LIMIT } from "../src/enrichment/enrich-pending.ts";
import { ENRICHMENT_SCHEMA_VERSION, EnrichmentV1 } from "../src/enrichment/enrichment-schema.ts";
import { GitHubPause } from "../src/enrichment/github-pause.ts";
import { deriveMatchText, MATCH_TEXT_VERSION } from "../src/enrichment/match-text.ts";
import { readEnrichmentStateInputs } from "../src/enrichment/state-inputs.ts";
import { deriveEnrichmentState, readSensitiveWarnThreshold } from "../src/enrichment/state.ts";
import {
  answer as llmAnswer,
  ANTHROPIC_ORIGIN,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_MESSAGES_URL,
  GATEWAY_ORIGIN,
  messageBody,
  MESSAGES_URL,
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
import { kind, noul, PROBABILITIES } from "./jev-answers.ts";
import { JEV_ORIGIN, networkError as jevNetworkError, status as jevStatus } from "./jev-fixture.ts";
import { seedBookmark, seedEnrichment, seedEnrichmentFailure, seedSignedInUser } from "./seed.ts";
import type { SeededBookmarkFields } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker();

let fixtures: EnrichmentFixtures;
let db: Db;
let config: EnrichmentConfig;
let threshold: number;
let userId: string;

// Long enough for the local D1 and MSW under load, and a backoff that doesn't slow the tests.
const timing: EnrichmentTiming = {
  jev: { attemptTimeoutMs: 2000, backoffInitialMs: 1 },
  github: { requestTimeoutMs: 2000 },
  provider: { requestTimeoutMs: 2000 },
};

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  db = createDb(env.DB);
  // The threshold Schalk chose, from wrangler.jsonc, so the tests hold bookmarks by the value
  // production uses. The secrets aren't bound in the harness, so the tests set their own.
  const SENSITIVE_WARN_THRESHOLD: string = env.SENSITIVE_WARN_THRESHOLD;
  threshold = readSensitiveWarnThreshold({ SENSITIVE_WARN_THRESHOLD });
  config = {
    SENSITIVE_WARN_THRESHOLD,
    JEV_BASE_URL: JEV_ORIGIN,
    JEV_MODEL: "jev-1.14.0",
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
  const DB = await d1();
  // Enrichments and failure records go with their bookmarks.
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  ({ userId } = await seedSignedInUser(DB, "owner@example.com"));
});

afterEach(() => {
  // No test makes a request that the fixtures didn't plan for, so none reaches the network.
  expect(fixtures.unplanned).toEqual([]);
});

const REPOSITORY_URL = "https://github.com/vitest-dev/vitest";

// A bookmark of the test runner's repository, as the save form stores it.
const REPOSITORY_FIELDS: SeededBookmarkFields = {
  title: "vitest-dev/vitest: Next generation testing framework powered by Vite.",
  capturedTitle: "GitHub - vitest-dev/vitest: Next generation testing framework powered by Vite.",
  ogSiteName: "GitHub",
};

// What GitHub says about it.
const REPOSITORY = {
  private: false,
  visibility: "public",
  description: "Next generation testing framework powered by Vite.",
  language: "TypeScript",
  topics: ["test", "vite"],
};

async function save(url: string, fields: SeededBookmarkFields = {}): Promise<string> {
  return seedBookmark(await d1(), userId, url, url, fields);
}

async function bookmarkRow(id: string) {
  const row = await db.select().from(bookmarks).where(eq(bookmarks.id, id)).get();
  if (row === undefined) {
    throw new Error("No such bookmark");
  }
  return row;
}

// Runs the module on the bookmark's row, as the sweep's query reads it.
async function enrich(
  id: string,
  overrides: Partial<EnrichmentConfig> = {},
): Promise<EnrichmentOutcome> {
  return enrichBookmark(db, { ...config, ...overrides }, await bookmarkRow(id), timing);
}

async function enrichmentRows(id: string) {
  return db.select().from(enrichments).where(eq(enrichments.bookmarkId, id)).all();
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

async function derivedState(id: string) {
  const inputs = (await readEnrichmentStateInputs(db, userId, ENRICHMENT_SCHEMA_VERSION)).find(
    (bookmark) => bookmark.bookmarkId === id,
  );
  if (inputs === undefined) {
    throw new Error("No such bookmark");
  }
  // The sweep's default (#127). The scheduled handler reads the limit from a `var` (#128).
  return deriveEnrichmentState(inputs, {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    sensitiveWarnThreshold: threshold,
    attemptLimit: DEFAULT_ATTEMPT_LIMIT,
  });
}

// The Jev request bodies, in order, by the question each asked.
function jevQuestions(): string[] {
  return fixtures.jev.requests.map(
    ({ body }) => Object.keys((JSON.parse(body) as { questions: object }).questions)[0] ?? "",
  );
}

function jevState(question: string): unknown {
  const request = fixtures.jev.requests.find(
    ({ body }) => question in (JSON.parse(body) as { questions: object }).questions,
  );
  return request === undefined ? undefined : (JSON.parse(request.body) as { state: unknown }).state;
}

// The user message of each LLM request, which holds the kind and the data sections.
function llmMessages(): string[] {
  return fixtures.llm.requests.map(
    ({ body }) =>
      (JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content ?? "",
  );
}

describe("enrichBookmark", () => {
  describe("Phase 7's acceptance", () => {
    it("ends a fixture bookmark with a valid enrichment row, and its derived state is Current", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      expect(await derivedState(id)).toBe("pending");
      fixtures.jev.respond(noul(0.02), kind("tool"));
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest\n\nA test runner."));
      fixtures.llm.respond(output(VALID_OUTPUT));
      const before = Date.now();

      expect(await enrich(id)).toEqual({ outcome: "enriched" });

      const rows = await enrichmentRows(id);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(v.parse(EnrichmentV1, row?.data)).toEqual(VALID_OUTPUT);
      expect(row).toMatchObject({
        bookmarkId: id,
        schemaVersion: ENRICHMENT_SCHEMA_VERSION,
        provider: "ai-gateway",
        model: "claude-haiku-5-5",
        kind: "tool",
        kindProbabilities: PROBABILITIES,
        matchText: deriveMatchText({
          title: REPOSITORY_FIELDS.title ?? "",
          kind: "tool",
          enrichment: VALID_OUTPUT,
        }),
        matchTextVersion: MATCH_TEXT_VERSION,
      });
      expect(row?.createdAt).toBeGreaterThanOrEqual(before);
      const stored = await bookmarkRow(id);
      expect(stored.sensitivityNoul).toBe(0.02);
      expect(stored.sensitivityCheckedAt).toBeGreaterThanOrEqual(before);
      expect(await failureRecord(id)).toBeUndefined();
      expect(await derivedState(id)).toBe("current");
    });

    it("asks Jev twice, GitHub twice and the LLM once, in the plan's order", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      await enrich(id);
      expect(jevQuestions()).toEqual(["private_access", "kind"]);
      expect(fixtures.github.requests.map(({ url }) => url)).toEqual([
        `${GITHUB_ORIGIN}/repos/vitest-dev/vitest`,
        `${GITHUB_ORIGIN}/repos/vitest-dev/vitest/readme`,
      ]);
      expect(fixtures.llm.requests.map(({ url }) => url)).toEqual([GATEWAY_MESSAGES_URL]);
    });
  });

  describe("the evidence", () => {
    it("gives the kind question and the LLM the same captured fields, leaving out empty ones", async () => {
      const id = await save("https://example.com/post", {
        title: "A post",
        description: "What the user wrote",
        ogTitle: "A post, shared",
        ogSiteName: "Example",
      });
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      await enrich(id);
      const bookmark = {
        url: "https://example.com/post",
        title: "A post",
        description: "What the user wrote",
        og_title: "A post, shared",
        og_site_name: "Example",
      };
      expect(jevState("kind")).toEqual({ bookmark });
      const [message] = llmMessages();
      expect(message).toContain("The bookmark's kind: article");
      expect(message).toContain(`<bookmark>\n${JSON.stringify(bookmark, null, 2)}\n</bookmark>`);
    });

    // The gate judges `url`, not the canonical URL, which the page chose (#157).
    it("sends the canonical URL only as describeUrlForJudgment's description, never in full", async () => {
      // A share link's key in the path, which the deterministic check doesn't recognize, so
      // POST /save would have stored it.
      const secret = "aB3xK9mQ2pL7vR5t";
      const canonicalUrl = `https://docs.example.com/share/${secret}/view`;
      expect(detectSensitiveUrl(new URL(canonicalUrl))).toBeUndefined();
      const id = await save("https://example.com/post", { title: "A post", canonicalUrl });
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      const description = describeUrlForJudgment(new URL(canonicalUrl), undefined, false);
      expect(description).toMatchObject({
        host: "docs.example.com",
        path: "/share/<random:16>/view",
      });
      expect(jevState("kind")).toEqual({
        bookmark: { url: "https://example.com/post", title: "A post", canonical_url: description },
      });
      // The data section's JSON, which JSON.parse reads back with its escaped `<`.
      const section = /<bookmark>\n(.*)\n<\/bookmark>/su.exec(llmMessages()[0] ?? "")?.[1];
      expect(JSON.parse(section ?? "null")).toMatchObject({ canonical_url: description });
      for (const { body } of [...fixtures.jev.requests, ...fixtures.llm.requests]) {
        expect(body).not.toContain(secret);
      }
    });
  });

  describe("the sensitivity gate", () => {
    it("sends Jev the page's title in describeUrlForJudgment's description, never the URL", async () => {
      const token = "Zx81kQ2mPa9wLr4T";
      const url = `https://docs.example.com/document/d/1aBcD9xQzLmNoPqRsTu/edit?token=${token}`;
      const id = await save(url, {
        title: "My planning notes",
        capturedTitle: "Q3 planning (draft) - Docs",
      });
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.llm.respond(output(VALID_OUTPUT));
      await enrich(id);
      const state = jevState("private_access");
      expect(state).toEqual({
        link: describeUrlForJudgment(new URL(url), "Q3 planning (draft) - Docs", false),
      });
      expect(JSON.stringify(state)).not.toContain(token);
      expect(JSON.stringify(state)).not.toContain("My planning notes");
    });

    it("tells Jev when the page declared a canonical URL that carried a secret", async () => {
      const id = await save("https://example.com/shared", { sensitiveCanonicalDropped: true });
      fixtures.jev.respond(noul(0.95));
      await enrich(id);
      expect(jevState("private_access")).toMatchObject({
        link: { declares_sensitive_canonical: true },
      });
    });

    it("runs only when sensitivity_noul is empty", async () => {
      const id = await save(REPOSITORY_URL, { ...REPOSITORY_FIELDS, sensitivityNoul: 0.1 });
      fixtures.jev.respond(kind());
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      expect(jevQuestions()).toEqual(["kind"]);
      const stored = await bookmarkRow(id);
      expect(stored.sensitivityNoul).toBe(0.1);
      expect(stored.sensitivityCheckedAt).toBeNull();
    });

    it("holds a bookmark above the threshold without an acknowledgment, with no GitHub, kind or LLM request", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.9));
      expect(await enrich(id)).toEqual({ outcome: "held" });
      expect(jevQuestions()).toEqual(["private_access"]);
      expect(fixtures.github.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
      expect((await bookmarkRow(id)).sensitivityNoul).toBe(0.9);
      expect(await enrichmentRows(id)).toEqual([]);
      expect(await derivedState(id)).toBe("held");
    });

    it("holds a bookmark exactly at the threshold, because the rule is at or above", async () => {
      const id = await save("https://example.com/at", { sensitivityNoul: threshold });
      expect(await enrich(id)).toEqual({ outcome: "held" });
      expect(fixtures.jev.requests).toEqual([]);
    });

    it("holds a bookmark already checked above the threshold without asking anything", async () => {
      const id = await save(REPOSITORY_URL, { ...REPOSITORY_FIELDS, sensitivityNoul: 0.9 });
      expect(await enrich(id)).toEqual({ outcome: "held" });
      expect(fixtures.jev.requests).toEqual([]);
      expect(fixtures.github.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
    });

    it("enriches an acknowledged bookmark above the threshold", async () => {
      const id = await save("https://example.com/invite", {
        sensitivityNoul: 0.9,
        sensitivityAcknowledgedAt: 1_000,
      });
      fixtures.jev.respond(kind("other"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      expect(await enrichmentRows(id)).toHaveLength(1);
      expect(await derivedState(id)).toBe("current");
    });

    it("doesn't count a Held bookmark as a failed attempt", async () => {
      const recorded = await save("https://example.com/recorded");
      const fresh = await save("https://example.com/fresh");
      await seedEnrichmentFailure(await d1(), recorded, ENRICHMENT_SCHEMA_VERSION, 1, 2);
      const before = await failureRecord(recorded);
      fixtures.jev.respond(noul(0.9), noul(0.9));
      expect(await enrich(recorded)).toEqual({ outcome: "held" });
      expect(await enrich(fresh)).toEqual({ outcome: "held" });
      expect(await failureRecord(recorded)).toEqual(before);
      expect(await failureRecord(fresh)).toBeUndefined();
    });
  });

  describe("GitHub", () => {
    it("falls back to the captured payload when GitHub fails", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.github.respond(githubStatus(500));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({
        outcome: "enriched",
        github: { reason: "status", status: 500 },
      });
      expect(fixtures.github.requests).toHaveLength(1);
      expect(jevState("kind")).not.toHaveProperty("github");
      const [message] = llmMessages();
      expect(message).toContain("<bookmark>");
      expect(message).not.toContain("<github_repository>");
      expect(message).not.toContain("<repository_context>");
      expect(await enrichmentRows(id)).toHaveLength(1);
    });

    it("reports a README failure in an enriched outcome, and keeps the repository's data", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.github.respond(githubJson(REPOSITORY), githubStatus(403));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({
        outcome: "enriched",
        github: { reason: "rate-limited", status: 403 },
      });
      expect(jevState("kind")).toMatchObject({
        github: { repository: "vitest-dev/vitest", description: REPOSITORY.description },
      });
      expect(jevState("kind")).not.toHaveProperty("github.readme_excerpt");
    });

    it("reports a rate limit in a failed outcome, so the sweep can stop asking GitHub", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02), jevStatus(400));
      fixtures.github.respond(githubStatus(403));
      expect(await enrich(id)).toEqual({
        outcome: "failed",
        step: "kind",
        failure: "permanent",
        reason: "status",
        status: 400,
        github: { reason: "rate-limited", status: 403 },
      });
    });

    it("enriches a GitHub issue as the issue, with the repository as context", async () => {
      const issue = `${REPOSITORY_URL}/issues/4321?ref=notifications`;
      const id = await save(issue, { title: "Snapshot tests fail on Windows · Issue #4321" });
      fixtures.jev.respond(noul(0.02), kind("discussion"));
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      // Only the repository's path goes to GitHub, never the issue or the query.
      expect(fixtures.github.requests.map(({ url }) => url)).toEqual([
        `${GITHUB_ORIGIN}/repos/vitest-dev/vitest`,
        `${GITHUB_ORIGIN}/repos/vitest-dev/vitest/readme`,
      ]);
      expect(jevState("kind")).toMatchObject({
        bookmark: { url: issue, title: "Snapshot tests fail on Windows · Issue #4321" },
        github: { repository: "vitest-dev/vitest", bookmark_is: "a page within the repository" },
      });
      const [message] = llmMessages();
      expect(message).toContain("<repository_context>");
      expect(message).not.toContain("<github_repository>");
      expect((await enrichmentRows(id))[0]?.kind).toBe("discussion");
    });

    it("gives the repository's own page GitHub's data as the repository", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      await enrich(id);
      expect(jevState("kind")).toMatchObject({ github: { bookmark_is: "the repository" } });
      expect(llmMessages()[0]).toContain("<github_repository>");
    });

    it("doesn't treat a reserved GitHub route as a repository", async () => {
      const id = await save("https://github.com/features/actions", { title: "GitHub Actions" });
      fixtures.jev.respond(noul(0.02), kind());
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      expect(fixtures.github.requests).toEqual([]);
      expect(jevState("kind")).not.toHaveProperty("github");
    });
  });

  describe("retries and failures", () => {
    it("retries invalid LLM output once, and then records a permanent failure", async () => {
      const id = await save("https://example.com/post");
      const invalid = { ...VALID_OUTPUT, summary: "x".repeat(281) };
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(output(invalid), output(invalid));
      const before = Date.now();
      expect(await enrich(id)).toEqual({
        outcome: "failed",
        step: "llm",
        failure: "permanent",
        reason: "invalid-output",
        issue: "summary: max_length",
      });
      expect(fixtures.llm.requests).toHaveLength(2);
      expect(await failureRecord(id)).toMatchObject({
        attempts: 1,
        consecutiveFailures: 1,
        lastError: "llm:invalid-output:summary: max_length",
      });
      expect((await failureRecord(id))?.lastAttemptAt).toBeGreaterThanOrEqual(before);
      expect(await enrichmentRows(id)).toEqual([]);
    });

    it("retries a Jev 429", async () => {
      const id = await save("https://example.com/post");
      fixtures.jev.respond(jevStatus(429), noul(0.02), jevStatus(429), kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      expect(jevQuestions()).toEqual(["private_access", "private_access", "kind", "kind"]);
    });

    it("counts a Jev failure after its retries as a failure, and stores no noul", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(jevStatus(503), jevStatus(503), jevStatus(503));
      expect(await enrich(id)).toEqual({
        outcome: "failed",
        step: "sensitivity",
        failure: "transient",
        reason: "status",
        status: 503,
      });
      expect(fixtures.jev.requests).toHaveLength(3);
      expect(fixtures.github.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
      expect((await bookmarkRow(id)).sensitivityNoul).toBeNull();
      expect(await failureRecord(id)).toMatchObject({
        attempts: 0,
        consecutiveFailures: 1,
        lastError: "sensitivity:status:503",
      });
    });

    it("records a transient failure's error and time without incrementing attempts", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 1);
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(llmStatus(529));
      const before = Date.now();
      expect(await enrich(id)).toMatchObject({
        outcome: "failed",
        step: "llm",
        failure: "transient",
        status: 529,
      });
      const record = await failureRecord(id);
      expect(record).toMatchObject({
        attempts: 1,
        consecutiveFailures: 2,
        lastError: "llm:status:529",
      });
      expect(record?.lastAttemptAt).toBeGreaterThanOrEqual(before);
    });

    it("increments attempts for a permanent failure", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 1, 3);
      fixtures.jev.respond(jevStatus(400));
      expect(await enrich(id)).toMatchObject({
        outcome: "failed",
        step: "kind",
        failure: "permanent",
      });
      expect(await failureRecord(id)).toMatchObject({
        attempts: 2,
        consecutiveFailures: 4,
        lastError: "kind:status:400",
      });
    });

    // Every 5th failure in a row counts as an attempt when it is transient, and a permanent one
    // counts once, whichever count it lands on (#127).
    it.each([
      ["a 5th transient failure in a row", 0, 4, "transient", 1, 5],
      ["a 10th transient failure in a row", 1, 9, "transient", 2, 10],
      ["a 6th transient failure in a row", 1, 5, "transient", 1, 6],
      ["a 4th transient failure in a row", 0, 3, "transient", 0, 4],
      ["a permanent failure that is the 5th in a row", 0, 4, "permanent", 1, 5],
    ] as const)(
      "counts %s as the plan says",
      async (_, attempts, consecutiveFailures, failure, expectedAttempts, expectedConsecutive) => {
        expect(TRANSIENT_FAILURES_PER_ATTEMPT).toBe(5);
        const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
        await seedEnrichmentFailure(
          await d1(),
          id,
          ENRICHMENT_SCHEMA_VERSION,
          attempts,
          consecutiveFailures,
        );
        if (failure === "transient") {
          fixtures.jev.respond(kind("article"));
          fixtures.llm.respond(llmStatus(529));
        } else {
          fixtures.jev.respond(jevStatus(400));
        }
        expect(await enrich(id)).toMatchObject({ outcome: "failed", failure });
        expect(await failureRecord(id)).toMatchObject({
          attempts: expectedAttempts,
          consecutiveFailures: expectedConsecutive,
        });
      },
    );

    // `consecutive_failures` counts both classes, so permanent failures in the run count toward
    // the multiple of 5: a transient failure that is the 5th failure in a row counts (#127).
    it("counts a transient failure after two permanent ones as the 5th, and moves the bookmark to Failed", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      // Two permanent failures and two transient ones, in some order.
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 2, 4);
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(llmStatus(529));
      expect(await enrich(id)).toMatchObject({ outcome: "failed", failure: "transient" });
      expect(await failureRecord(id)).toMatchObject({ attempts: 3, consecutiveFailures: 5 });
      expect(await derivedState(id)).toBe("failed");
    });

    it("counts 4 transient failures, a permanent one and a transient one as 1 attempt in 6", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const transient = () => {
        fixtures.jev.respond(kind("article"));
        fixtures.llm.respond(llmStatus(529));
      };
      const permanent = () => fixtures.jev.respond(jevStatus(400));
      for (const respond of [transient, transient, transient, transient, permanent, transient]) {
        respond();
        await enrich(id);
      }
      expect(await failureRecord(id)).toMatchObject({ attempts: 1, consecutiveFailures: 6 });
      expect(await derivedState(id)).toBe("pending");
    });

    // #127's case: a bookmark whose LLM request always times out reaches Failed, and /held,
    // after 15 tries, rather than being retried for good.
    it("moves a bookmark whose LLM request always times out to Failed after 15 runs", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const late = async () => {
        await delay(500);
        return HttpResponse.json(messageBody(JSON.stringify(VALID_OUTPUT)));
      };
      const shortened = { ...timing, provider: { requestTimeoutMs: 50 } };
      for (let run = 1; run <= 15; run += 1) {
        fixtures.jev.respond(kind("article"));
        fixtures.llm.respond(late);
        expect(await enrichBookmark(db, config, await bookmarkRow(id), shortened)).toEqual({
          outcome: "failed",
          step: "llm",
          failure: "transient",
          reason: "timeout",
        });
        expect(await failureRecord(id)).toMatchObject({
          attempts: Math.floor(run / 5),
          consecutiveFailures: run,
        });
        expect(await derivedState(id)).toBe(run < 15 ? "pending" : "failed");
      }
      expect(fixtures.llm.requests).toHaveLength(15);
    });

    it("moves a bookmark to Failed at the attempt limit", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 2);
      fixtures.jev.respond(jevStatus(400));
      await enrich(id);
      expect(await derivedState(id)).toBe("failed");
    });

    it("gives each client the time limits it is passed, as the on-save path shortens them", async () => {
      const id = await save("https://example.com/post");
      const late = async () => {
        await delay(500);
        return HttpResponse.json({});
      };
      fixtures.jev.respond(late, late, late);
      const shortened = { ...timing, jev: { attemptTimeoutMs: 50, backoffInitialMs: 1 } };
      expect(await enrichBookmark(db, config, await bookmarkRow(id), shortened)).toMatchObject({
        outcome: "failed",
        step: "sensitivity",
        reason: "timeout",
      });
      expect((await failureRecord(id))?.lastError).toBe("sensitivity:timeout");
    });

    // Q3 counts 3 + 2 + 3 + 2 outside requests per bookmark, which holds only if the module adds
    // no retries of its own to the clients'.
    it("makes at most 10 outside requests, the worst case Q3 counts", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(
        jevStatus(503),
        jevStatus(503),
        noul(0.02),
        jevStatus(503),
        jevNetworkError,
        kind(),
      );
      fixtures.github.respond(githubJson(REPOSITORY), readme("# Vitest"));
      fixtures.llm.respond(output({ ...VALID_OUTPUT, extra: "x" }), output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      expect(
        fixtures.jev.requests.length +
          fixtures.github.requests.length +
          fixtures.llm.requests.length,
      ).toBe(10);
    });
  });

  // A service that rejects Haystack's own account would fail every bookmark the same way, so the
  // module records nothing against the bookmark and throws, for the sweep to stop its run (#127).
  describe("a rejected account", () => {
    // The error the module throws, or a failure of the test if it returned instead.
    async function accountError(id: string): Promise<EnrichmentAccountError> {
      const error = await enrich(id).then(
        (outcome) => new Error(`Expected a thrown error, got ${JSON.stringify(outcome)}`),
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(EnrichmentAccountError);
      return error as EnrichmentAccountError;
    }

    // A bookmark that has failed before, so a change to its record would show.
    async function saveWithFailure(url: string, fields: SeededBookmarkFields = {}) {
      const id = await save(url, fields);
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 1, 4);
      return { id, before: await failureRecord(id) };
    }

    it("stops for Jev's 401 at the sensitivity question, recording nothing", async () => {
      const { id, before } = await saveWithFailure(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(jevStatus(401));
      expect(await accountError(id)).toMatchObject({
        code: "ENRICHMENT_ACCOUNT_REJECTED",
        step: "sensitivity",
        reason: "status",
        status: 401,
      });
      // Not retried, and nothing more is asked.
      expect(fixtures.jev.requests).toHaveLength(1);
      expect(fixtures.github.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
      expect(await failureRecord(id)).toEqual(before);
      expect((await bookmarkRow(id)).sensitivityNoul).toBeNull();
      expect(await derivedState(id)).toBe("pending");
    });

    it("stops for Jev's 403 at the kind question, recording no failure", async () => {
      const { id, before } = await saveWithFailure("https://example.com/post");
      fixtures.jev.respond(noul(0.02), jevStatus(403));
      expect(await accountError(id)).toMatchObject({ step: "kind", status: 403 });
      expect(fixtures.llm.requests).toEqual([]);
      expect(await failureRecord(id)).toEqual(before);
      expect(await enrichmentRows(id)).toEqual([]);
    });

    it.each([
      ["a 401", llmStatus(401), "status", 401],
      ["a 402, a billing problem", llmStatus(402), "status", 402],
      ["a 403", llmStatus(403), "status", 403],
      [
        "a spend limit's 400 (#154)",
        () =>
          HttpResponse.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
              },
              request_id: "req_fixture",
            },
            { status: 400 },
          ),
        "spend-limit",
        400,
      ],
    ])("stops for the LLM's %s, recording no failure", async (_, response, reason, code) => {
      const { id, before } = await saveWithFailure("https://example.com/post");
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(response);
      expect(await accountError(id)).toMatchObject({ step: "llm", reason, status: code });
      // Not asked again, as invalid output would be.
      expect(fixtures.llm.requests).toHaveLength(1);
      expect(await failureRecord(id)).toEqual(before);
      expect(await enrichmentRows(id)).toEqual([]);
    });

    it.each([
      ["the repository", () => fixtures.github.respond(githubStatus(401))],
      ["the README", () => fixtures.github.respond(githubJson(REPOSITORY), githubStatus(401))],
    ])("stops for GitHub's 401 for %s, before the kind question", async (_, respond) => {
      const { id, before } = await saveWithFailure(REPOSITORY_URL, REPOSITORY_FIELDS);
      fixtures.jev.respond(noul(0.02));
      respond();
      expect(await accountError(id)).toMatchObject({
        step: "github",
        reason: "unauthorized",
        status: 401,
      });
      expect(jevQuestions()).toEqual(["private_access"]);
      expect(fixtures.llm.requests).toEqual([]);
      expect(await failureRecord(id)).toEqual(before);
    });

    it("tells the run nothing about the bookmark, so it can be logged", async () => {
      const url = "https://docs.example.com/share/plan?token=Zx81kQ2mPa9wLr4T";
      const id = await save(url, { title: "Title Captured-7c1e" });
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(llmStatus(402));
      const error = await accountError(id);
      expect(error.message).toBe("A service rejected Haystack's account (llm:status:402)");
      const { code, step, reason, status, message } = error;
      const logged = JSON.stringify({ code, step, reason, status, message });
      for (const leaked of ["Zx81kQ2mPa9wLr4T", "Captured-7c1e", "docs.example.com", "fixture"]) {
        expect(logged).not.toContain(leaked);
      }
    });
  });

  // What a sweep run's bookmarks share (EnrichmentRun, #127): the controller that stops the run, and
  // its pause on GitHub. enrich-pending.test.ts shows the sweep using them.
  describe("in a sweep run", () => {
    const stopped = new Error("The run stopped");

    // Runs the module with the run's controller and, optionally, its pause on GitHub.
    async function enrichInRun(id: string, controller: AbortController, github?: GitHubPause) {
      return enrichBookmark(db, config, await bookmarkRow(id), timing, {
        controller,
        ...(github === undefined ? {} : { github }),
      });
    }

    it("records no failure that arrives after the run stopped, and throws the stop's reason", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 1, 4);
      const before = await failureRecord(id);
      const run = new AbortController();
      fixtures.jev.respond(kind("article"));
      // The run stops while the LLM request is under way, and then the request fails.
      fixtures.llm.respond((request) => {
        run.abort(stopped);
        return llmStatus(529)(request);
      });
      await expect(enrichInRun(id, run)).rejects.toBe(stopped);
      expect(await failureRecord(id)).toEqual(before);
    });

    it("sends nothing at all for a run that has already stopped", async () => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      const run = new AbortController();
      run.abort(stopped);
      await expect(enrichInRun(id, run)).rejects.toBe(stopped);
      expect(fixtures.jev.requests).toEqual([]);
    });

    // The run stops while one step's request is under way, and the next step isn't taken. The
    // answer that came is still stored, as the noul is.
    it.each([
      ["the GitHub read", REPOSITORY_URL, ["private_access"]],
      ["the kind question", "https://example.com/post", ["private_access"]],
    ])(
      "sends nothing more once the run stopped, so not %s, and keeps the noul",
      async (_, url, questions) => {
        const id = await save(url, REPOSITORY_FIELDS);
        const run = new AbortController();
        fixtures.jev.respond((request) => {
          run.abort(stopped);
          return noul(0.02)(request);
        });
        await expect(enrichInRun(id, run)).rejects.toBe(stopped);
        expect(jevQuestions()).toEqual(questions);
        expect(fixtures.github.requests).toEqual([]);
        expect(fixtures.llm.requests).toEqual([]);
        expect((await bookmarkRow(id)).sensitivityNoul).toBe(0.02);
        expect(await failureRecord(id)).toBeUndefined();
      },
    );

    it("sends nothing more once the run stopped, so not the LLM request", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const run = new AbortController();
      fixtures.jev.respond((request) => {
        run.abort(stopped);
        return kind("article")(request);
      });
      await expect(enrichInRun(id, run)).rejects.toBe(stopped);
      expect(fixtures.llm.requests).toEqual([]);
      expect(await enrichmentRows(id)).toEqual([]);
    });

    it("stores an enrichment whose answer came after the run stopped, because it was paid for", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const run = new AbortController();
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond((request) => {
        run.abort(stopped);
        return output(VALID_OUTPUT)(request);
      });
      expect(await enrichInRun(id, run)).toEqual({ outcome: "enriched" });
      expect(await derivedState(id)).toBe("current");
    });

    it("still reports a rejected account that arrives after the run stopped", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      const run = new AbortController();
      fixtures.jev.respond((request) => {
        run.abort(stopped);
        return jevStatus(401)(request);
      });
      await expect(enrichInRun(id, run)).rejects.toBeInstanceOf(EnrichmentAccountError);
    });

    // So the run's other bookmarks stop at their next step, without waiting for this error to
    // reach the sweep.
    it.each([
      ["Jev", () => fixtures.jev.respond(jevStatus(401))],
      [
        "GitHub",
        () => {
          fixtures.jev.respond(noul(0.02));
          fixtures.github.respond(githubStatus(401));
        },
      ],
    ])("stops the run itself when %s rejects the account", async (_, respond) => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      const run = new AbortController();
      respond();
      const thrown = await enrichInRun(id, run).catch((caught: unknown) => caught);
      expect(thrown).toBeInstanceOf(EnrichmentAccountError);
      expect(run.signal.aborted).toBe(true);
      expect(run.signal.reason).toBe(thrown);
    });

    it("asks GitHub nothing once the run's pause is on, and enriches from what was captured", async () => {
      const id = await save(REPOSITORY_URL, { ...REPOSITORY_FIELDS, sensitivityNoul: 0.02 });
      const github = new GitHubPause();
      await github.read(async () => ({
        ok: false,
        reason: "rate-limited",
        status: 403,
        requests: 1,
      }));
      fixtures.jev.respond(kind());
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrichInRun(id, new AbortController(), github)).toEqual({
        outcome: "enriched",
      });
      expect(fixtures.github.requests).toEqual([]);
      expect(jevState("kind")).not.toHaveProperty("github");
      expect(llmMessages()[0]).not.toContain("<github_repository>");
    });

    it("turns the run's pause on when GitHub rate-limits its own read", async () => {
      const id = await save(REPOSITORY_URL, { ...REPOSITORY_FIELDS, sensitivityNoul: 0.02 });
      const github = new GitHubPause();
      fixtures.github.respond(githubStatus(403, { "x-ratelimit-remaining": "0" }));
      fixtures.jev.respond(kind());
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrichInRun(id, new AbortController(), github)).toEqual({
        outcome: "enriched",
        github: { reason: "rate-limited", status: 403 },
      });
      expect(github.paused).toBe(true);
    });
  });

  describe("the write", () => {
    it("does nothing on a second insert for the same bookmark and schema version", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      // Another run, such as the on-save path, enriched it first.
      const first = await seedEnrichment(await d1(), id, ENRICHMENT_SCHEMA_VERSION);
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 1);
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id)).toEqual({ outcome: "enriched" });
      const rows = await enrichmentRows(id);
      expect(rows.map(({ id: rowId, provider }) => ({ rowId, provider }))).toEqual([
        { rowId: first, provider: "seed" },
      ]);
      // The bookmark is Current either way, so its failure record goes.
      expect(await failureRecord(id)).toBeUndefined();
    });

    it("removes the failure record at this schema version only", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 2);
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION + 1, 1);
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      await enrich(id);
      expect(await failureRecord(id)).toBeUndefined();
      expect(await failureRecord(id, ENRICHMENT_SCHEMA_VERSION + 1)).toMatchObject({ attempts: 1 });
    });

    it("writes the enrichment and the failure record's removal together or not at all", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await seedEnrichmentFailure(await d1(), id, ENRICHMENT_SCHEMA_VERSION, 2);
      const before = await failureRecord(id);
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      // The batch inserts the enrichment first, and this makes its second statement, the
      // removal, fail, so the insert has run by then and must be rolled back with it.
      const DB = await d1();
      await DB.prepare(
        "CREATE TRIGGER fail_failure_removal BEFORE DELETE ON enrichment_failures BEGIN SELECT RAISE(ABORT, 'the removal failed'); END",
      ).run();
      try {
        // Only that it fails: the rows below are what show the batch was one transaction.
        await expect(enrich(id)).rejects.toThrow();
      } finally {
        await DB.prepare("DROP TRIGGER fail_failure_removal").run();
      }
      expect(await enrichmentRows(id)).toEqual([]);
      expect(await failureRecord(id)).toEqual(before);
    });
  });

  describe("last_error", () => {
    // Text that appears nowhere else, so finding it in last_error is a leak.
    const SECRET = "Zx81kQ2mPa9wLr4T";
    const CAPTURED = "Captured-7c1e";
    const BODY = "Response-body-3f9a";
    const URL_WITH_SECRET = `https://docs.example.com/share/plan?token=${SECRET}`;
    const fields: SeededBookmarkFields = {
      title: `Title ${CAPTURED}`,
      description: `Description ${CAPTURED}`,
      capturedTitle: `Page ${CAPTURED}`,
      ogTitle: `Shared ${CAPTURED}`,
    };
    // The format `lastError` documents: fixed codes, a status, and a ValidationIssue.
    const GRAMMAR =
      /^(?:sensitivity|kind|llm):(?:timeout|network|status|invalid-response|refused|truncated|invalid-output)(?::\d{3})?(?::[a-z0-9_.()\s]+: [a-z_]+)?$/u;
    const withBody = (code: number) => () =>
      HttpResponse.json({ detail: `${BODY} ${URL_WITH_SECRET}` }, { status: code });

    it.each([
      [
        "a sensitivity question that can't be sent",
        () => fixtures.jev.respond(jevNetworkError, jevNetworkError, jevNetworkError),
        "sensitivity:network",
      ],
      [
        "a kind question rejected with a body",
        () => fixtures.jev.respond(noul(0.02), withBody(400)),
        "kind:status:400",
      ],
      [
        "a provider error with a body",
        () => {
          fixtures.jev.respond(noul(0.02), kind("article"));
          fixtures.llm.respond(withBody(404));
        },
        "llm:status:404",
      ],
      [
        "LLM output with a key of captured text",
        () => {
          const leaky = { ...VALID_OUTPUT, [`${CAPTURED} ${URL_WITH_SECRET}`]: BODY };
          fixtures.jev.respond(noul(0.02), kind("article"));
          fixtures.llm.respond(output(leaky), output(leaky));
        },
        "llm:invalid-output:(unknown key): strict_object",
      ],
      [
        "LLM output that isn't JSON",
        () => {
          fixtures.jev.respond(noul(0.02), kind("article"));
          fixtures.llm.respond(llmAnswer(messageBody(`${BODY} ${URL_WITH_SECRET}`)));
        },
        "llm:invalid-response",
      ],
    ])(
      "holds only fixed codes for %s, never the URL, captured text or a body",
      async (_, respond, expected) => {
        const id = await save(URL_WITH_SECRET, fields);
        respond();
        await enrich(id);
        const lastError = (await failureRecord(id))?.lastError ?? "";
        expect(lastError).toBe(expected);
        expect(lastError).toMatch(GRAMMAR);
        for (const leaked of [SECRET, CAPTURED, BODY, "docs.example.com", "share/plan"]) {
          expect(lastError).not.toContain(leaked);
        }
      },
    );
  });

  describe("the provider setting", () => {
    it("records the provider's id and the model that answered, not the one asked for", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      fixtures.jev.respond(kind("article"));
      fixtures.llm.respond(
        llmAnswer({
          ...messageBody(JSON.stringify(VALID_OUTPUT)),
          model: "claude-haiku-5-5-20261001",
        }),
      );
      await enrich(id, { ENRICHMENT_PROVIDER: "anthropic" });
      expect(fixtures.llm.requests.map(({ url }) => url)).toEqual([MESSAGES_URL]);
      expect((await enrichmentRows(id))[0]).toMatchObject({
        provider: "anthropic",
        model: "claude-haiku-5-5-20261001",
      });
    });
  });

  // A configuration error is the same for every bookmark, so it isn't recorded against this one.
  describe("configuration errors", () => {
    // Each is the run's problem rather than the bookmark's, and is found before the first
    // request, so a run that meets one pays for no Jev question or GitHub request.
    async function expectNothingSentOrStored(id: string) {
      expect(fixtures.jev.requests).toEqual([]);
      expect(fixtures.github.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
      expect((await bookmarkRow(id)).sensitivityNoul).toBeNull();
      expect(await failureRecord(id)).toBeUndefined();
      expect(await enrichmentRows(id)).toEqual([]);
    }

    it.each([
      ["an unknown provider", { ENRICHMENT_PROVIDER: "openai" }, "ENRICHMENT_PROVIDER_UNKNOWN"],
      [
        "a threshold that isn't a number from 0 to 1",
        { SENSITIVE_WARN_THRESHOLD: "high" },
        "SENSITIVE_WARN_THRESHOLD_INVALID",
      ],
      ["an empty TypeSafe key", { TYPESAFE_API_KEY: "" }, "TYPESAFE_API_KEY_EMPTY"],
      ["an empty GitHub token", { GITHUB_TOKEN: "" }, "GITHUB_TOKEN_EMPTY"],
      ["an empty Anthropic key", { ANTHROPIC_API_KEY: "" }, "ANTHROPIC_API_KEY_EMPTY"],
      ["an empty model", { ANTHROPIC_MODEL: "" }, "ANTHROPIC_MODEL_EMPTY"],
      ["an empty gateway token", { AI_GATEWAY_TOKEN: "" }, "AI_GATEWAY_TOKEN_EMPTY"],
      ["an empty gateway ID", { AI_GATEWAY_ID: "" }, "AI_GATEWAY_ID_EMPTY"],
      [
        "an empty Anthropic key, with the provider that sends it directly",
        { ENRICHMENT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" },
        "ANTHROPIC_API_KEY_EMPTY",
      ],
    ])("throws for %s before anything is sent or stored", async (_, overrides, code) => {
      const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
      await expect(enrich(id, overrides)).rejects.toMatchObject({ code });
      await expectNothingSentOrStored(id);
    });

    // Each client's base URL, with a code that names it (#155).
    const baseUrls: [string, (value: string) => Partial<EnrichmentConfig>][] = [
      ["JEV_BASE_URL", (value) => ({ JEV_BASE_URL: value })],
      ["GITHUB_API_BASE_URL", (value) => ({ GITHUB_API_BASE_URL: value })],
      ["AI_GATEWAY_BASE_URL", (value) => ({ AI_GATEWAY_BASE_URL: value })],
      [
        "ANTHROPIC_BASE_URL",
        (value) => ({ ENRICHMENT_PROVIDER: "anthropic", ANTHROPIC_BASE_URL: value }),
      ],
    ];
    const badValues: [string, string][] = [
      ["neither https nor http on a loopback host", "http://service.test"],
      ["empty", ""],
      ["missing", undefined as unknown as string],
      ["not a URL", "service.test"],
    ];
    for (const [name, overrides] of baseUrls) {
      it.each(badValues)(
        `throws ${name}_INVALID when ${name} is %s, before anything is sent`,
        async (_, value) => {
          const id = await save(REPOSITORY_URL, REPOSITORY_FIELDS);
          await expect(enrich(id, overrides(value))).rejects.toMatchObject({
            code: `${name}_INVALID`,
          });
          await expectNothingSentOrStored(id);
        },
      );
    }

    it("checks Jev's key for a bookmark already checked, because the kind question needs it", async () => {
      const id = await save("https://example.com/post", { sensitivityNoul: 0.02 });
      await expect(enrich(id, { TYPESAFE_API_KEY: "" })).rejects.toMatchObject({
        code: "TYPESAFE_API_KEY_EMPTY",
      });
      expect(fixtures.jev.requests).toEqual([]);
      expect(fixtures.llm.requests).toEqual([]);
    });

    it("doesn't need GitHub's token for a bookmark that isn't on GitHub", async () => {
      const id = await save("https://example.com/post");
      fixtures.jev.respond(noul(0.02), kind("article"));
      fixtures.llm.respond(output(VALID_OUTPUT));
      expect(await enrich(id, { GITHUB_TOKEN: "" })).toEqual({ outcome: "enriched" });
    });
  });
});
