// The scheduled run (#128): the Worker's `scheduled()` handler under Wrangler's test harness, and
// runScheduled with a fake Flagship binding, against the real local D1 from the harness. The
// harness can't set a flag (Q13 in plans/haystack-v1-implementation-plan.md), so the harness's
// run uses the defaults, and the tests that need other flag values call runScheduled in this
// process with a fake binding (flags.test.ts has the configuration module's own tests). Every
// outside request, the Worker's included, is answered by the enrichment fixtures
// (enrichment-fixtures.ts), which fail a test that makes a request they did not plan for.
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
import { deleteExpiredAuthFlows } from "../src/auth/auth-flows.ts";
import { deleteExpiredSessions } from "../src/auth/sessions.ts";
import { createDb } from "../src/db/client.ts";
import type { EnrichmentConfig } from "../src/enrichment/enrich-bookmark.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import {
  type FlagDetails,
  type FlagReader,
  SWEEP_BATCH_SIZE_FLAG,
  SWEEP_ENABLED_FLAG,
} from "../src/flags.ts";
import { readSweepAttemptLimit, runScheduled, type ScheduledEnv } from "../src/scheduled.ts";
import {
  ANTHROPIC_ORIGIN,
  GATEWAY_ACCOUNT_ID,
  GATEWAY_ID,
  GATEWAY_ORIGIN,
  output,
} from "./anthropic-fixture.ts";
import { type EnrichmentFixtures, startEnrichmentFixtures } from "./enrichment-fixtures.ts";
import { VALID_OUTPUT } from "./enrichment-output.ts";
import { GITHUB_ORIGIN } from "./github-fixture.ts";
import { kind, noul } from "./jev-answers.ts";
import { JEV_ORIGIN, status as jevStatus } from "./jev-fixture.ts";
import { seedBookmark, seedEnrichmentFailure, seedSignedInUser } from "./seed.ts";

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
  TYPESAFE_API_KEY: "ts-test-key-5b1e8d20",
  GITHUB_TOKEN: "github_pat_test_0c6f3a91",
  ANTHROPIC_API_KEY: "sk-ant-test-key-71d4e9b6",
  AI_GATEWAY_TOKEN: "cf-aig-test-token-2a8c5f17",
};

// The fixtures start first, because the harness sends the Worker's requests through this
// process's `fetch`, which they patch (page-fixture.ts).
let fixtures: EnrichmentFixtures;
let server: ReturnType<typeof createTestHarness>;
// The run's configuration from wrangler.jsonc, with the fixtures' addresses and the test keys.
let config: EnrichmentConfig & { SWEEP_ATTEMPT_LIMIT: string };
let userId: string;
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  fixtures = startEnrichmentFixtures();
  server = createTestHarness({
    workers: [
      {
        configPath: new URL("../wrangler.jsonc", import.meta.url),
        vars: SERVICE_VARS,
        secrets: SERVICE_SECRETS,
      },
    ],
  });
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  config = {
    ...SERVICE_VARS,
    ...SERVICE_SECRETS,
    JEV_MODEL: env.JEV_MODEL,
    ENRICHMENT_PROVIDER: env.ENRICHMENT_PROVIDER,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    SENSITIVE_WARN_THRESHOLD: env.SENSITIVE_WARN_THRESHOLD,
    SWEEP_ATTEMPT_LIMIT: env.SWEEP_ATTEMPT_LIMIT,
  };
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
    DB.prepare("DELETE FROM auth_flows"),
    DB.prepare("DELETE FROM users"),
  ]);
  ({ userId } = await seedSignedInUser(DB, "owner@example.com"));
  // The run logs its summaries and errors. The tests read them, and keep them out of the output.
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // No test makes a request that the fixtures didn't plan for, so none reaches the network.
  expect(fixtures.unplanned).toEqual([]);
});

/** A fake binding with these flags set, which gives the default for any other, as a missing flag. */
function fakeFlags(values: Record<string, unknown>): FlagReader {
  const read = async <T>(key: string, defaultValue: T): Promise<FlagDetails<T>> =>
    Object.hasOwn(values, key)
      ? { value: values[key] as T }
      : { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
  return { getBooleanDetails: read, getNumberDetails: read };
}

async function scheduledEnv(
  flags: FlagReader,
  overrides: Partial<ScheduledEnv> = {},
): Promise<ScheduledEnv> {
  return { ...config, DB: await d1(), FLAGS: flags, ...overrides };
}

/**
 * Bookmarks that aren't on GitHub, oldest first, each with its sensitivity answer stored, so a
 * run asks Jev only the `kind` question and the LLM once for each. Their answers are all alike,
 * so they can arrive in any order.
 */
async function seedPending(count: number): Promise<string[]> {
  const DB = await d1();
  const start = Date.now() - HOUR;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = `https://site-${index}.example/`;
    ids.push(
      await seedBookmark(DB, userId, url, url, {
        sensitivityNoul: 0.05,
        sensitivityCheckedAt: start,
        createdAt: start + index * 1000,
      }),
    );
  }
  return ids;
}

/** Answers `count` bookmarks seeded by seedPending. */
function answerPending(count: number): void {
  fixtures.jev.respond(...Array.from({ length: count }, () => kind()));
  fixtures.llm.respond(...Array.from({ length: count }, () => output(VALID_OUTPUT)));
}

/** The bookmarks enriched at the current schema version. */
async function enrichedIds(): Promise<string[]> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT bookmark_id FROM enrichments WHERE schema_version = ? ORDER BY bookmark_id")
    .bind(ENRICHMENT_SCHEMA_VERSION)
    .all();
  return results.map((row: { bookmark_id: string }) => row.bookmark_id);
}

/**
 * A session and a sign-in flow that have expired, and one of each that hasn't. Returns the keys
 * of those that should stay: the seeded user's own session, and the live ones here.
 */
async function seedExpiryRows(): Promise<{ sessions: string[]; authFlows: string[] }> {
  const DB = await d1();
  const now = Date.now();
  const rows = [
    ["expired-session", now - 1000],
    ["live-session", now + HOUR],
  ] as const;
  for (const [idHash, expiresAt] of rows) {
    await DB.prepare(
      "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(idHash, userId, expiresAt, now - HOUR)
      .run();
  }
  for (const [stateHash, expiresAt] of [
    ["expired-flow", now - 1000],
    ["live-flow", now + HOUR],
  ] as const) {
    await DB.prepare(
      "INSERT INTO auth_flows (state_hash, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(stateHash, "verifier", "/", expiresAt, now - HOUR)
      .run();
  }
  const sessions = (await remainingSessions()).filter((key) => key !== "expired-session");
  return { sessions, authFlows: ["live-flow"] };
}

async function remainingSessions(): Promise<string[]> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT id_hash FROM sessions ORDER BY id_hash")
    .all();
  return results.map((row: { id_hash: string }) => row.id_hash);
}

async function remainingAuthFlows(): Promise<string[]> {
  const { results } = await (
    await d1()
  )
    .prepare("SELECT state_hash FROM auth_flows ORDER BY state_hash")
    .all();
  return results.map((row: { state_hash: string }) => row.state_hash);
}

describe("the scheduled handler", () => {
  it("runs the sweep and the cleanup when the harness triggers it, with the defaults", async () => {
    const DB = await d1();
    const url = "https://scheduled.example/";
    const bookmarkId = await seedBookmark(DB, userId, url, url);
    const kept = await seedExpiryRows();
    fixtures.jev.respond(noul(0.05), kind());
    fixtures.llm.respond(output(VALID_OUTPUT));

    const result = await server.getWorker().scheduled({ cron: "*/5 * * * *" });

    expect(result.outcome).toBe("ok");
    expect(await enrichedIds()).toEqual([bookmarkId]);
    expect(await remainingSessions()).toEqual(kept.sessions);
    expect(await remainingAuthFlows()).toEqual(kept.authFlows);
    // The summaries hold counts only, never the bookmark's address.
    const logs = JSON.stringify(server.getLogs());
    expect(logs).toContain("Enrichment sweep:");
    expect(logs).toContain("Expired rows deleted:");
    expect(logs).not.toContain("scheduled.example");
  });
});

describe("runScheduled", () => {
  it("passes the batch size flag to the sweep", async () => {
    await seedPending(3);
    answerPending(2);

    const { sweep } = await runScheduled(
      await scheduledEnv(fakeFlags({ [SWEEP_BATCH_SIZE_FLAG]: 2 })),
    );

    expect(sweep).toMatchObject({ selected: 2, enriched: 2, moreOutstanding: true, stopped: null });
  });

  it.each([4, 0, 2.5])(
    "gives the sweep a batch of 3 when the batch size flag is %s",
    async (batchSize) => {
      await seedPending(4);
      answerPending(3);

      const { sweep } = await runScheduled(
        await scheduledEnv(fakeFlags({ [SWEEP_BATCH_SIZE_FLAG]: batchSize })),
      );

      expect(sweep).toMatchObject({ selected: 3, enriched: 3, moreOutstanding: true });
    },
  );

  it("runs with every default when the binding throws", async () => {
    await seedPending(4);
    answerPending(3);
    const failing: FlagReader = {
      getBooleanDetails: async () => {
        throw new Error("Flagship is unavailable");
      },
      getNumberDetails: async () => ({ value: 1 }),
    };

    const { sweep } = await runScheduled(await scheduledEnv(failing));

    expect(sweep).toMatchObject({ selected: 3, enriched: 3 });
  });

  it("stops only the sweep when its flag is off, and still deletes expired rows", async () => {
    await seedPending(2);
    const kept = await seedExpiryRows();

    const result = await runScheduled(
      await scheduledEnv(fakeFlags({ [SWEEP_ENABLED_FLAG]: false })),
    );

    expect(result).toEqual({ sweep: null, cleanup: { sessions: 1, authFlows: 1 } });
    expect(fixtures.jev.requests).toEqual([]);
    expect(fixtures.llm.requests).toEqual([]);
    expect(await enrichedIds()).toEqual([]);
    expect(await remainingSessions()).toEqual(kept.sessions);
    expect(await remainingAuthFlows()).toEqual(kept.authFlows);
    expect(info).toHaveBeenCalledWith("Enrichment sweep skipped:", { flag: SWEEP_ENABLED_FLAG });
  });

  it("still deletes expired rows when the sweep stops early", async () => {
    await seedPending(1);
    const kept = await seedExpiryRows();
    // TypeSafe rejects the key, which stops the run (#127).
    fixtures.jev.respond(jevStatus(401));

    const { sweep, cleanup } = await runScheduled(await scheduledEnv(fakeFlags({})));

    expect(sweep).toMatchObject({ selected: 1, unfinished: 1, stopped: "account" });
    expect(cleanup).toEqual({ sessions: 1, authFlows: 1 });
    expect(await remainingSessions()).toEqual(kept.sessions);
    expect(await remainingAuthFlows()).toEqual(kept.authFlows);
  });

  it("passes the attempt limit to the sweep", async () => {
    // A bookmark with 3 attempts, outside its backoff window: Failed at a limit of 3, and
    // Pending at a limit of 4.
    const [bookmarkId] = await seedPending(1);
    await seedEnrichmentFailure(
      await d1(),
      bookmarkId!,
      ENRICHMENT_SCHEMA_VERSION,
      3,
      3,
      Date.now() - 7 * HOUR,
    );

    const atThree = await runScheduled(await scheduledEnv(fakeFlags({})));
    expect(atThree.sweep).toMatchObject({ selected: 0 });

    answerPending(1);
    const atFour = await runScheduled(
      await scheduledEnv(fakeFlags({}), { SWEEP_ATTEMPT_LIMIT: "4" }),
    );
    expect(atFour.sweep).toMatchObject({ selected: 1, enriched: 1 });
  });

  it("fails the run for an attempt limit it can't read, after the cleanup", async () => {
    await seedPending(1);
    const kept = await seedExpiryRows();

    await expect(
      runScheduled(await scheduledEnv(fakeFlags({}), { SWEEP_ATTEMPT_LIMIT: "three" })),
    ).rejects.toThrow("The scheduled run failed (sweep:SWEEP_ATTEMPT_LIMIT_INVALID)");

    // The sweep sent nothing, and the cleanup ran.
    expect(fixtures.jev.requests).toEqual([]);
    expect(await remainingSessions()).toEqual(kept.sessions);
    expect(await remainingAuthFlows()).toEqual(kept.authFlows);
    expect(error).toHaveBeenCalledWith("Scheduled run error:", {
      step: "sweep",
      code: "SWEEP_ATTEMPT_LIMIT_INVALID",
    });
  });

  it("fails the run for an attempt limit it can't read while the sweep is off", async () => {
    await seedPending(1);
    const kept = await seedExpiryRows();

    await expect(
      runScheduled(
        await scheduledEnv(fakeFlags({ [SWEEP_ENABLED_FLAG]: false }), {
          SWEEP_ATTEMPT_LIMIT: "three",
        }),
      ),
    ).rejects.toThrow("The scheduled run failed (sweep:SWEEP_ATTEMPT_LIMIT_INVALID)");

    // The sweep didn't run, and the cleanup did.
    expect(fixtures.jev.requests).toEqual([]);
    expect(fixtures.llm.requests).toEqual([]);
    expect(await enrichedIds()).toEqual([]);
    expect(await remainingSessions()).toEqual(kept.sessions);
    expect(await remainingAuthFlows()).toEqual(kept.authFlows);
  });

  it("fails the run when the cleanup throws, after the sweep", async () => {
    await seedPending(1);
    answerPending(1);
    await seedExpiryRows();
    const DB = await d1();
    // The cleanup's deletion of sessions fails, while the sweep's statements work.
    await DB.prepare(
      "CREATE TRIGGER fail_session_cleanup BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'the cleanup failed'); END",
    ).run();
    try {
      await expect(runScheduled(await scheduledEnv(fakeFlags({})))).rejects.toThrow(
        /^The scheduled run failed \(cleanup:[\w]+\)$/,
      );
    } finally {
      await DB.prepare("DROP TRIGGER fail_session_cleanup").run();
    }
    expect(await enrichedIds()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      "Scheduled run error:",
      expect.objectContaining({ step: "cleanup" }),
    );
  });
});

describe("readSweepAttemptLimit", () => {
  it.each(["1", "3", "10"])("reads %s", (value) => {
    expect(readSweepAttemptLimit({ SWEEP_ATTEMPT_LIMIT: value })).toBe(Number(value));
  });

  it.each(["", "0", "-1", "2.5", "3 ", " 3", "0x3", "1e1", "03", "three", "9007199254740993"])(
    "throws for %j",
    (value) => {
      expect(() => readSweepAttemptLimit({ SWEEP_ATTEMPT_LIMIT: value })).toThrow(
        expect.objectContaining({ code: "SWEEP_ATTEMPT_LIMIT_INVALID" }),
      );
    },
  );

  it("throws when the var is missing", () => {
    const missing = {} as { SWEEP_ATTEMPT_LIMIT: string };

    expect(() => readSweepAttemptLimit(missing)).toThrow(
      expect.objectContaining({ code: "SWEEP_ATTEMPT_LIMIT_INVALID" }),
    );
  });
});

describe("the cleanup", () => {
  it("deletes rows that expire at or before now, and keeps later ones", async () => {
    const DB = await d1();
    const db = createDb(DB);
    const now = Date.now();
    for (const [key, expiresAt] of [
      ["before", now - 1],
      ["at", now],
      ["after", now + 1],
    ] as const) {
      await DB.prepare(
        "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(`session-${key}`, userId, expiresAt, now - HOUR)
        .run();
      await DB.prepare(
        "INSERT INTO auth_flows (state_hash, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(`flow-${key}`, "verifier", "/", expiresAt, now - HOUR)
        .run();
    }
    const before = await remainingSessions();

    expect(await deleteExpiredSessions(db, now)).toBe(2);
    expect(await deleteExpiredAuthFlows(db, now)).toBe(2);

    expect(await remainingSessions()).toEqual(
      before.filter((key) => key !== "session-before" && key !== "session-at"),
    );
    expect(await remainingAuthFlows()).toEqual(["flow-after"]);
  });
});
