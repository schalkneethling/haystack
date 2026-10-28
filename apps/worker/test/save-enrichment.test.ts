// The on-save path (#133): POST /save enriches the bookmark it has just inserted inside
// `ctx.waitUntil`, so the "Saved" page doesn't wait for it, and whatever the path misses is left
// to the sweep. The Worker runs under Wrangler's test harness, against its real local D1, and
// every request it makes is answered by the enrichment fixtures (enrichment-fixtures.ts), which
// fail a test that makes a request they did not plan for. See "Enrichment sweep", "Jev client",
// Q3 and Phase 9 in plans/haystack-v1-implementation-plan.md.
//
// The on-save path runs after the response, so a test that needs its outcome waits for the line
// it always ends with, `On-save enrichment:` or `On-save enrichment error:`, by polling the
// Worker's logs, never for a fixed time.
import { eq } from "drizzle-orm";
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
import { createDb, type Db } from "../src/db/client.ts";
import { bookmarks, enrichmentFailures, enrichments } from "../src/db/schema.ts";
import { type EnrichmentConfig, ENRICHMENT_TIMING } from "../src/enrichment/enrich-bookmark.ts";
import { ON_SAVE_TIMING } from "../src/enrichment/enrich-on-save.ts";
import {
  DEFAULT_ATTEMPT_LIMIT,
  enrichPending,
  selectBookmarksToEnrich,
} from "../src/enrichment/enrich-pending.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import { JEV_ATTEMPT_LIMIT } from "../src/enrichment/jev-client.ts";
import { readEnrichmentStateInputs } from "../src/enrichment/state-inputs.ts";
import {
  backoffWindowMs,
  deriveEnrichmentState,
  readSensitiveWarnThreshold,
} from "../src/enrichment/state.ts";
import {
  ANTHROPIC_ORIGIN,
  type AnthropicResolver,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_ORIGIN,
  output,
  status as llmStatus,
} from "./anthropic-fixture.ts";
import { type EnrichmentFixtures, startEnrichmentFixtures } from "./enrichment-fixtures.ts";
import { VALID_OUTPUT } from "./enrichment-output.ts";
import { GITHUB_ORIGIN } from "./github-fixture.ts";
import { kind, noul } from "./jev-answers.ts";
import { JEV_ORIGIN, status as jevStatus } from "./jev-fixture.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { createTestWorker, type TestWorker } from "./test-worker.ts";

// The services' fixture addresses, and keys that aren't real, for the Worker and for this process.
const SERVICE_VARS = {
  JEV_BASE_URL: JEV_ORIGIN,
  GITHUB_API_BASE_URL: GITHUB_ORIGIN,
  ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN,
  AI_GATEWAY_BASE_URL: GATEWAY_ORIGIN,
  AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT_ID,
  AI_GATEWAY_ID: GATEWAY_ID,
};
const SERVICE_SECRETS = {
  TYPESAFE_API_KEY: "ts-test-key-8e2c41d7",
  GITHUB_TOKEN: "github_pat_test_6a0d9f53",
  ANTHROPIC_API_KEY: "sk-ant-test-key-2f7b8c14",
  AI_GATEWAY_TOKEN: "cf-aig-test-token-5d3e0a96",
};

// How long a test waits for the on-save path's last log line before it fails. The path takes
// milliseconds against the fixtures, so this is headroom for a busy machine, not a wait.
const ON_SAVE_DONE_MS = 4000;

let fixtures: EnrichmentFixtures;
let server: TestWorker;
let origin: string;
let db: Db;
// The Worker's configuration, for the sweep that a test runs in this process.
let config: EnrichmentConfig;
let threshold: number;
let owner: SeededUser;
// Every held LLM answer, released after each test, so a failed test leaves no request waiting.
const holds: (() => void)[] = [];

// The fixtures start first, because the harness sends the Worker's requests through this
// process's `fetch`, which they patch (page-fixture.ts).
beforeAll(async () => {
  fixtures = startEnrichmentFixtures();
  server = createTestWorker({
    vars: { ALLOWED_EMAILS: "owner@example.com", ...SERVICE_VARS },
    secrets: SERVICE_SECRETS,
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  db = createDb(env.DB);
  config = {
    ...SERVICE_VARS,
    ...SERVICE_SECRETS,
    JEV_MODEL: env.JEV_MODEL,
    ENRICHMENT_PROVIDER: env.ENRICHMENT_PROVIDER,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    SENSITIVE_WARN_THRESHOLD: env.SENSITIVE_WARN_THRESHOLD,
  };
  threshold = readSensitiveWarnThreshold(config);
});

afterAll(async () => {
  await server.close();
  fixtures.close();
});

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

beforeEach(async () => {
  fixtures.reset();
  server.clearLogs();
  const DB = await d1();
  // Enrichments and failure records go with their bookmarks, and sessions with their users.
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

afterEach(() => {
  for (const release of holds.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
  // No test makes a request that the fixtures didn't plan for, so none reaches the network.
  expect(fixtures.unplanned).toEqual([]);
});

// A page with no part that the sensitive URL check flags, and the parts of it no log may hold.
const SAVED_URL = "https://docs.example/guides/on-save";
const SUBMISSION = {
  url: SAVED_URL,
  title: "A guide to saving",
  description: "How saving works",
  confirmed_title: "My saving guide",
  confirmed_description: "Notes",
};
const PRIVATE_PARTS = ["docs.example", "on-save", "A guide to saving", "My saving guide"];

function postSave(fields: Record<string, string> = SUBMISSION) {
  return server.fetch("/save", {
    method: "POST",
    headers: { accept: "text/html", origin, cookie: owner.cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

// The one bookmark a test saved.
async function savedBookmark() {
  const row = await db.select().from(bookmarks).get();
  if (row === undefined) {
    throw new Error("No bookmark was saved");
  }
  return row;
}

async function bookmarkId(): Promise<string> {
  return (await savedBookmark()).id;
}

function onSaveLogs(): { level: string; message: string }[] {
  return server
    .getLogs()
    .map(({ level, message }) => ({ level, message }))
    .filter(({ message }) => message.startsWith("On-save enrichment"));
}

// The on-save path's last line, once it has logged it.
async function onSaveDone(): Promise<{ level: string; message: string }> {
  return vi.waitFor(
    () => {
      const [line, ...others] = onSaveLogs();
      if (line === undefined) {
        throw new Error("The on-save path hasn't finished");
      }
      expect(others).toEqual([]);
      return line;
    },
    { timeout: ON_SAVE_DONE_MS },
  );
}

async function enrichmentRows(id: string) {
  return db
    .select({ id: enrichments.id, provider: enrichments.provider })
    .from(enrichments)
    .where(eq(enrichments.bookmarkId, id))
    .all();
}

async function failureRecord(id: string) {
  return db
    .select({
      attempts: enrichmentFailures.attempts,
      consecutiveFailures: enrichmentFailures.consecutiveFailures,
      lastError: enrichmentFailures.lastError,
      lastAttemptAt: enrichmentFailures.lastAttemptAt,
    })
    .from(enrichmentFailures)
    .where(eq(enrichmentFailures.bookmarkId, id))
    .get();
}

async function derivedState(id: string) {
  const inputs = (
    await readEnrichmentStateInputs(db, owner.userId, ENRICHMENT_SCHEMA_VERSION)
  ).find((bookmark) => bookmark.bookmarkId === id);
  if (inputs === undefined) {
    throw new Error("No such bookmark");
  }
  return deriveEnrichmentState(inputs, {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    sensitiveWarnThreshold: threshold,
    attemptLimit: DEFAULT_ATTEMPT_LIMIT,
  });
}

// The ids the sweep's selection would pick at `now`.
async function selectedBySweep(now: number): Promise<string[]> {
  const selection = await selectBookmarksToEnrich(db, {
    batchSize: 3,
    attemptLimit: DEFAULT_ATTEMPT_LIMIT,
    sensitiveWarnThreshold: threshold,
    now,
  });
  return selection.bookmarks.map(({ id }) => id);
}

// The question each Jev request asked, in order.
function jevQuestions(): string[] {
  return fixtures.jev.requests.map(
    ({ body }) => Object.keys((JSON.parse(body) as { questions: object }).questions)[0] ?? "",
  );
}

/**
 * An LLM answer that the fixture holds until the test releases it. `arrived` resolves when the
 * Worker's request reaches the fixture.
 */
function heldAnswer(): { resolver: AnthropicResolver; arrived: Promise<void>; release(): void } {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  holds.push(release);
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    resolver: async (request) => {
      arrive();
      await released;
      return output(VALID_OUTPUT)(request);
    },
    arrived,
    release,
  };
}

function expectNoPrivatePartsLogged(): void {
  const everything = JSON.stringify(server.getLogs());
  for (const part of PRIVATE_PARTS) {
    expect(everything).not.toContain(part);
  }
}

describe("POST /save's on-save enrichment", () => {
  it("enriches the new bookmark, and logs its outcome without the address", async () => {
    fixtures.jev.respond(noul(0.05), kind("tutorial"));
    fixtures.llm.respond(output(VALID_OUTPUT));

    const response = await postSave();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Saved</h1>");

    const line = await onSaveDone();
    expect(line.level).toBe("info");
    expect(line.message).toContain("outcome: 'enriched'");
    expect(line.message).toContain("elapsedMs:");
    const id = await bookmarkId();
    expect(await enrichmentRows(id)).toEqual([{ id: expect.any(String), provider: "ai-gateway" }]);
    expect(await derivedState(id)).toBe("current");
    expectNoPrivatePartsLogged();
  });

  it("doesn't delay the saved response while the LLM's answer is held", async () => {
    const held = heldAnswer();
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(held.resolver);

    // The LLM's answer hasn't been released, so if the response waited for the enrichment, this
    // would never resolve.
    const response = await postSave();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Saved</h1>");
    await held.arrived;
    const id = await bookmarkId();
    expect(await enrichmentRows(id)).toEqual([]);
    expect(onSaveLogs()).toEqual([]);

    held.release();
    expect((await onSaveDone()).message).toContain("outcome: 'enriched'");
    expect(await enrichmentRows(id)).toHaveLength(1);
  });

  it("doesn't ask Jev's sensitivity question again when the save form's check answered", async () => {
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(output(VALID_OUTPUT));
    await postSave();
    await onSaveDone();
    // One sensitivity question, the save's own, and the kind question.
    expect(jevQuestions()).toEqual(["private_access", "kind"]);
  });

  it("asks the sensitivity question again when the save form's check got no answer", async () => {
    // The save's check fails, so the bookmark is saved with its noul left empty, and the gate asks.
    fixtures.jev.respond(jevStatus(503), noul(0.05), kind());
    fixtures.llm.respond(output(VALID_OUTPUT));
    await postSave();
    expect((await onSaveDone()).message).toContain("outcome: 'enriched'");
    expect(jevQuestions()).toEqual(["private_access", "private_access", "kind"]);
    expect((await savedBookmark()).sensitivityNoul).toBe(0.05);
  });

  it("holds a bookmark that the gate finds might be private, and sends it nowhere else", async () => {
    fixtures.jev.respond(jevStatus(503), noul(0.9));
    await postSave();
    expect((await onSaveDone()).message).toContain("outcome: 'held'");
    expect(jevQuestions()).toEqual(["private_access", "private_access"]);
    expect(fixtures.llm.requests).toEqual([]);
    expect(await derivedState(await bookmarkId())).toBe("held");
  });

  it("doesn't run for a link that is saved already", async () => {
    await seedBookmark(await d1(), owner.userId, SAVED_URL, SAVED_URL);
    const response = await postSave();
    expect(await response.text()).toContain("You already saved this link");
    expect(fixtures.jev.requests).toEqual([]);
    // A new link's save, whose on-save path is the only one to finish: onSaveDone fails for a
    // second line, and an on-save path for the first save would also have asked Jev first.
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(output(VALID_OUTPUT));
    await postSave({ ...SUBMISSION, url: "https://docs.example/guides/another" });
    expect((await onSaveDone()).message).toContain("outcome: 'enriched'");
    expect(jevQuestions()).toEqual(["private_access", "kind"]);
  });
});

describe("a failure on save", () => {
  it("records a failed outcome as the sweep does, so the sweep tries the bookmark again", async () => {
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(llmStatus(529));
    const response = await postSave();
    expect(response.status).toBe(200);

    const line = await onSaveDone();
    expect(line.level).toBe("info");
    expect(line.message).toContain("outcome: 'failed'");
    expect(line.message).toContain("step: 'llm'");
    expect(line.message).toContain("failure: 'transient'");
    const id = await bookmarkId();
    const failure = await failureRecord(id);
    expect(failure).toMatchObject({
      attempts: 0,
      consecutiveFailures: 1,
      lastError: "llm:status:529",
    });
    expect(await derivedState(id)).toBe("pending");
    // The sweep picks it up once its backoff window ends.
    const windowEnds = (failure?.lastAttemptAt ?? 0) + backoffWindowMs(1);
    expect(await selectedBySweep(windowEnds - 1)).toEqual([]);
    expect(await selectedBySweep(windowEnds)).toEqual([id]);
    expectNoPrivatePartsLogged();
  });

  it("records nothing for a thrown error, logs its codes, and leaves the bookmark to the sweep's next run", async () => {
    // A rejected account is thrown, not returned (EnrichmentAccountError).
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(llmStatus(401));
    const response = await postSave();
    expect(response.status).toBe(200);

    const line = await onSaveDone();
    expect(line.level).toBe("error");
    expect(line.message).toContain("On-save enrichment error:");
    expect(line.message).toContain("code: 'ENRICHMENT_ACCOUNT_REJECTED'");
    expect(line.message).toContain("step: 'llm'");
    expect(line.message).toContain("status: 401");
    // The on-save path catches it, so nothing else is logged as an error, such as an unhandled
    // rejection from `ctx.waitUntil`.
    expect(server.getLogs().filter(({ level }) => level === "error")).toHaveLength(1);
    const id = await bookmarkId();
    expect(await failureRecord(id)).toBeUndefined();
    expect(await derivedState(id)).toBe("pending");
    expect(await selectedBySweep(Date.now())).toEqual([id]);
    expectNoPrivatePartsLogged();
  });
});

describe("the on-save path and the sweep together", () => {
  it("stays harmless when the sweep enriches the bookmark while the on-save path is under way", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const held = heldAnswer();
    // The save's check and the on-save kind question, then the sweep's kind question.
    fixtures.jev.respond(noul(0.05), kind(), kind());
    fixtures.llm.respond(held.resolver, output(VALID_OUTPUT));

    await postSave();
    await held.arrived;
    const id = await bookmarkId();
    // The sweep, in this process, selects the bookmark while the on-save path waits for the LLM.
    const summary = await enrichPending(db, config);
    expect(summary).toMatchObject({ selected: 1, enriched: 1, failed: 0, stopped: null });
    const [first] = await enrichmentRows(id);

    held.release();
    expect((await onSaveDone()).message).toContain("outcome: 'enriched'");
    // The on-save path's insert did nothing, so the sweep's enrichment is the only one.
    expect(await enrichmentRows(id)).toEqual([first]);
    expect(await failureRecord(id)).toBeUndefined();
    expect(await derivedState(id)).toBe("current");
  });
});

describe("the on-save timing", () => {
  it("makes one attempt at a Jev question, where the sweep's timing would make three", async () => {
    // The kind question fails transiently. The sweep's timing would retry it.
    expect(ENRICHMENT_TIMING.jev.attemptLimit ?? JEV_ATTEMPT_LIMIT).toBe(3);
    fixtures.jev.respond(noul(0.05), jevStatus(503));
    await postSave();
    expect((await onSaveDone()).message).toContain("outcome: 'failed'");
    expect(jevQuestions()).toEqual(["private_access", "kind"]);
    expect(fixtures.llm.requests).toEqual([]);
    expect(await failureRecord(await bookmarkId())).toMatchObject({
      lastError: "kind:status:503",
    });
  });

  it("fits a bookmark's worst case into the 30 seconds that ctx.waitUntil allows, with headroom", () => {
    // Cloudflare's "Context (ctx)" page: up to 30 seconds after the response, then cancelled.
    const waitUntilMs = 30_000;
    const { jev, github, provider } = ON_SAVE_TIMING;
    // One attempt per Jev question means no backoff and no Retry-After wait between attempts.
    expect(jev.attemptLimit).toBe(1);
    const worstCaseMs =
      // The sensitivity question, when the save's check got no answer, and the kind question.
      2 * jev.attemptTimeoutMs +
      // GitHub's repository and README requests.
      2 * github.requestTimeoutMs +
      // The LLM call and its one retry after invalid output.
      2 * provider.requestTimeoutMs;
    expect(worstCaseMs).toBe(27_000);
    // At least 2 seconds left for the D1 statements and the CPU time.
    expect(waitUntilMs - worstCaseMs).toBeGreaterThanOrEqual(2000);
  });
});
