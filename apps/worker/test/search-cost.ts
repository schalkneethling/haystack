// Measures what a search costs in CPU time and D1 rows (#214), against a synthetic collection of
// known size, for the plan's "Search page" and Q1, Q3 and Q12. It is a measurement, not a test:
// nothing in src/ or the test suites imports it. Run it with `vp -C apps/worker run search-cost`,
// which needs Node 24 or later (`process.threadCpuUsage`, `node:sqlite`), and no key, since the
// requests to Jev are answered in this process. See "What a search costs" in the plan for what the
// numbers show and what they can't.
//
// It runs the route's function (`postSearch`, with the service) in two ways, on the same
// collection:
//
// 1. CPU time. The Worker's own code runs in Node, against `node:sqlite` behind the part of D1's
//    interface that Drizzle calls, and a `fetch` that answers Jev in this process. Node's
//    `process.threadCpuUsage()` is the thread's exact CPU time. Two parts are taken out of each
//    search's total, because neither is the Worker's CPU time in production: the time inside
//    SQLite (D1 runs it elsewhere, so a query costs the Worker its round trip, which is waiting),
//    and the time the fake Jev spends building its answer. What is left is the time the Worker's
//    JavaScript takes: reading and mapping rows, building and serialising each request, parsing
//    and validating each response, ranking, and building the logged rows and the answer.
// 2. Rows. The same search runs against the local D1 that Wrangler's test harness provides, with
//    a wrapper that adds up each statement's `meta.rows_read` and `meta.rows_written`.
//
// The collection is made of bookmarks with the lengths of production's: 450 to 645 characters of
// `match_text` (plan, Q3, "The `match_text` token counts"), a title of about 70 characters, a
// description of about 180, and an enrichment `data` of about 1.5 kB. Jev's answers are made up:
// about one bookmark in ten clears both thresholds.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { authenticateSession } from "../src/auth/sessions.ts";
import { createDb, type Db } from "../src/db/client.ts";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import { type FlagDetails, type FlagReader, SEARCH_REQUEST_MODE_FLAG } from "../src/flags.ts";
import { JevLimiter } from "../src/search/jev-limiter.ts";
import { searchBookmarks } from "../src/search/search-bookmarks.ts";
import { type SearchRouteEnv, postSearch } from "../src/search-route.ts";
import { seedSignedInUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const JEV_BASE_URL = "http://127.0.0.1:8790";
const QUERY = "a test runner for a Vite project";

type RequestMode = "batched" | "pair";

// D1's binding, as Drizzle takes it. The Workers types that name it aren't in this program.
type D1Binding = Parameters<typeof createDb>[0];

interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

// ---- The collection ----------------------------------------------------------------------------

// Text of about `length` characters, made of words, so that it is as compressible and as long as
// prose is. It differs for each bookmark, by its number.
const WORDS =
  "a tool for running tests in a browser with fast feedback and a small configuration file".split(
    " ",
  );

function text(seed: number, length: number): string {
  let out = "";
  for (let index = seed; out.length < length; index += 1) {
    out += `${WORDS[(index * 7 + seed) % WORDS.length]} `;
  }
  return out.slice(0, length).trim();
}

interface Seeded {
  readonly userId: string;
  readonly cookie: string;
}

const GROUP = 25;

// Seeds the collection through `db`, in groups, because D1 limits a statement to 100 kB.
async function seedCollection(db: D1Like, size: number): Promise<Seeded> {
  const { userId, cookie } = await seedSignedInUser(db, "owner@example.com");
  const now = Date.now();
  for (let start = 0; start < size; start += GROUP) {
    const rows = Array.from({ length: Math.min(GROUP, size - start) }, (_, offset) => {
      const index = start + offset;
      return {
        id: crypto.randomUUID(),
        enrichmentId: crypto.randomUUID(),
        url: `https://example.com/synthetic/${index}/${text(index, 20).replaceAll(" ", "-")}`,
        title: `${index} ${text(index, 66)}`.slice(0, 70),
        description: text(index + 1, 180),
        matchText: text(index + 2, 450 + (index % 196)),
        data: JSON.stringify({ summary: text(index + 3, 1500) }),
        createdAt: now - index * 1000,
      };
    });
    await db
      .prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, description, created_at) SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.url'), json_extract(value, '$.url'), json_extract(value, '$.title'), json_extract(value, '$.description'), json_extract(value, '$.createdAt') FROM json_each(?2)",
      )
      .bind(userId, JSON.stringify(rows))
      .run();
    await db
      .prepare(
        "INSERT INTO enrichments (id, bookmark_id, schema_version, provider, model, kind, kind_probabilities, data, match_text, match_text_version, created_at) SELECT json_extract(value, '$.enrichmentId'), json_extract(value, '$.id'), ?1, 'seed', 'seed', 'tool', '{}', json_extract(value, '$.data'), json_extract(value, '$.matchText'), 1, json_extract(value, '$.createdAt') FROM json_each(?2)",
      )
      .bind(ENRICHMENT_SCHEMA_VERSION, JSON.stringify(rows))
      .run();
  }
  return { userId, cookie };
}

// ---- CPU time ----------------------------------------------------------------------------------

function cpuMicroseconds(): number {
  const { user, system } = process.threadCpuUsage();
  return user + system;
}

/** Microseconds of CPU time spent in the parts that production doesn't charge the Worker for. */
const outside = { sqlite: 0, jev: 0 };

function timed<T>(part: keyof typeof outside, work: () => T): T {
  const start = cpuMicroseconds();
  try {
    return work();
  } finally {
    outside[part] += cpuMicroseconds() - start;
  }
}

type Row = Record<string, unknown>;

// The part of D1's interface that Drizzle's D1 driver calls, over `node:sqlite`. A statement's
// time in SQLite is counted in `outside.sqlite`.
function sqliteD1(sqlite: DatabaseSync) {
  function statement(sql: string, values: unknown[]) {
    const read = (): Row[] =>
      timed("sqlite", () => sqlite.prepare(sql).all(...(values as never[])));
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      all: async () => ({ results: read(), success: true, meta: {} }),
      // D1's `raw()` gives the rows as arrays, with no wrapper.
      raw: async () =>
        timed("sqlite", () => {
          const prepared = sqlite.prepare(sql);
          prepared.setReturnArrays(true);
          return prepared.all(...(values as never[]));
        }),
      first: async () => read()[0] ?? null,
      run: async () => {
        timed("sqlite", () => sqlite.prepare(sql).run(...(values as never[])));
        return { results: [], success: true, meta: {} };
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql, []),
    // D1 runs a batch as one transaction.
    batch: async (statements: ReturnType<typeof statement>[]) => {
      timed("sqlite", () => sqlite.exec("BEGIN"));
      try {
        const results = [];
        for (const one of statements) {
          results.push(await one.all());
        }
        timed("sqlite", () => sqlite.exec("COMMIT"));
        return results;
      } catch (error) {
        timed("sqlite", () => sqlite.exec("ROLLBACK"));
        throw error;
      }
    },
  };
}

function migratedSqlite(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .toSorted()) {
    sqlite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  }
  return sqlite;
}

// A Jev that answers in this process: each question of the request gets an answer of its type, for
// each bookmark, with about one in ten above both thresholds. Its own time, parsing the request
// and building the answer, is `outside.jev`. Other requests go on to the real fetch.
const realFetch = globalThis.fetch;
let requestsToJev = 0;

// By the bookmark's title, which is its own in either mode, whatever alias a request gives it.
function answerFor(title: string): { noul: number; score: number } {
  const hash = createHash("sha256").update(title).digest().readUInt32BE(0) % 1000;
  return hash < 100 ? { noul: 0.9, score: 2.8 } : { noul: 0.1, score: 0.4 };
}

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(JEV_BASE_URL)) {
    return realFetch(input, init);
  }
  requestsToJev += 1;
  return timed("jev", () => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      state: { bookmarks: Record<string, { title: string }> };
      questions: Record<string, { type: string }>;
    };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const alias = id.replace(/_(helps|relevance)$/u, "");
      const { noul, score } = answerFor(body.state.bookmarks[alias]?.title ?? alias);
      answers[id] =
        question.type === "noul"
          ? { type: "noul", noul }
          : {
              type: "score",
              score,
              confidence: 0.41,
              probabilities: { "0": 0.1, "1": 0.1, "2": 0.2, "3": 0.6 },
            };
    }
    return new Response(
      JSON.stringify({
        model: "jev-1.14.0",
        answers,
        usage: { input_tokens: 150 * Object.keys(body.state.bookmarks).length, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
};

function flagsFor(mode: RequestMode): FlagReader {
  const read = async <T>(key: string, defaultValue: T): Promise<FlagDetails<T>> =>
    key === SEARCH_REQUEST_MODE_FLAG && mode === "pair"
      ? { value: "pair" as T }
      : { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
  return { getBooleanDetails: read, getNumberDetails: read, getStringDetails: read };
}

function envFor(mode: RequestMode): SearchRouteEnv {
  return {
    JEV_BASE_URL,
    JEV_MODEL: "jev-1.14.0",
    TYPESAFE_API_KEY: "ts-measurement-key",
    SENSITIVE_WARN_THRESHOLD: "0.5",
    SWEEP_ATTEMPT_LIMIT: "3",
    FLAGS: flagsFor(mode),
  };
}

// The route's whole work for one request: the session lookup, then `postSearch`, with a limiter
// that never waits, because waiting isn't CPU time.
async function oneRequest(db: Db, seeded: Seeded, mode: RequestMode): Promise<Response> {
  const sessionId = seeded.cookie.slice("__Host-session=".length);
  const session = await authenticateSession(
    db,
    sessionId,
    new Set(["owner@example.com"]),
    Date.now(),
  );
  if (session === undefined) {
    throw new Error("The seeded session was not accepted");
  }
  const limiter = new JevLimiter({ requestsPerSecond: 1_000_000, tokensPerSecond: 1_000_000_000 });
  return postSearch(
    new Request("https://haystack.test/api/search", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY }),
    }),
    // Nothing to keep alive: the process waits for the search itself.
    { waitUntil: () => {} },
    db,
    session.user.id,
    envFor(mode),
    (userId, query, source, context) =>
      searchBookmarks(userId, query, source, { ...context, limiter }),
  );
}

interface CpuSample {
  readonly totalMs: number;
  readonly workerMs: number;
  readonly sqliteMs: number;
  readonly jevRequests: number;
  readonly results: number;
}

async function measureOnce(db: Db, seeded: Seeded, mode: RequestMode): Promise<CpuSample> {
  outside.sqlite = 0;
  outside.jev = 0;
  requestsToJev = 0;
  const start = cpuMicroseconds();
  const response = await oneRequest(db, seeded, mode);
  const total = cpuMicroseconds() - start;
  const answer = (await response.json()) as { outcome?: string; results?: unknown[] };
  if (response.status !== 200 || answer.outcome !== "ok") {
    throw new Error(
      `The search answered ${response.status} ${JSON.stringify(answer).slice(0, 80)}`,
    );
  }
  return {
    totalMs: total / 1000,
    workerMs: (total - outside.sqlite - outside.jev) / 1000,
    sqliteMs: outside.sqlite / 1000,
    jevRequests: requestsToJev,
    results: answer.results?.length ?? 0,
  };
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const fixed = (value: number) => value.toFixed(1);

// ---- Rows --------------------------------------------------------------------------------------

interface Rows {
  read: number;
  written: number;
  statements: number;
  /** Rows read and written by each statement, keyed by the start of its SQL, in order. */
  byStatement: Map<string, { count: number; read: number; written: number }>;
}

interface Meta {
  readonly rows_read?: number;
  readonly rows_written?: number;
}

// Wraps a D1 binding so that every statement's meta is added to `rows`. A statement made by
// `prepare().bind()` is wrapped, and `batch` unwraps them for the real binding.
function countingD1(real: D1Binding, rows: Rows): D1Binding {
  const add = <Result extends { meta?: Meta }>(result: Result, sql = ""): Result => {
    rows.read += result.meta?.rows_read ?? 0;
    rows.written += result.meta?.rows_written ?? 0;
    rows.statements += 1;
    const key = sql.replaceAll(/\s+/gu, " ").slice(0, 90);
    const entry = rows.byStatement.get(key) ?? { count: 0, read: 0, written: 0 };
    entry.count += 1;
    entry.read += result.meta?.rows_read ?? 0;
    entry.written += result.meta?.rows_written ?? 0;
    rows.byStatement.set(key, entry);
    return result;
  };
  type Inner = ReturnType<D1Binding["prepare"]>;
  function wrap(inner: Inner, sql: string) {
    return {
      inner,
      sql,
      bind: (...values: unknown[]) => wrap(inner.bind(...values), sql),
      all: async () => add(await inner.all(), sql),
      first: async (column?: string) => {
        // `first()` returns the row, not the meta, so the statement runs as `all()` for counting.
        const result = add(await inner.all(), sql);
        const row = result.results[0] as Record<string, unknown> | undefined;
        return column === undefined ? (row ?? null) : (row?.[column] ?? null);
      },
      raw: async (options?: { columnNames?: boolean }) => {
        // `raw()` returns no meta either, so the same statement is counted by running it as
        // `all()` first. That doubles its time, not its rows, which are counted once.
        add(await inner.all(), sql);
        return options?.columnNames === true ? inner.raw({ columnNames: true }) : inner.raw();
      },
      run: async () => add(await inner.run(), sql),
    };
  }
  return {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: async (statements: ReturnType<typeof wrap>[]) => {
      const results = await real.batch(statements.map(({ inner }) => inner));
      for (const [index, result] of results.entries()) {
        add(result as { meta?: Meta }, statements[index]?.sql ?? "");
      }
      return results;
    },
  } as unknown as D1Binding;
}

async function measureRows(
  sizes: readonly number[],
  mode: RequestMode,
): Promise<Map<number, Rows & { results: number }>> {
  const server = createTestWorker();
  const out = new Map<number, Rows & { results: number }>();
  try {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
    const DB = (await server.getWorker().getEnv()).DB;
    for (const size of sizes) {
      await DB.batch([
        DB.prepare("DELETE FROM search_runs"),
        DB.prepare("DELETE FROM bookmarks"),
        DB.prepare("DELETE FROM sessions"),
        DB.prepare("DELETE FROM users"),
      ]);
      const seeded = await seedCollection(DB, size);
      const rows: Rows = { read: 0, written: 0, statements: 0, byStatement: new Map() };
      const db = createDb(countingD1(DB, rows));
      const response = await oneRequest(db, seeded, mode);
      const answer = (await response.json()) as { results?: unknown[] };
      out.set(size, { ...rows, results: answer.results?.length ?? 0 });
      if (size === Math.max(...sizes) && mode === "batched") {
        console.log(`\nRows by statement, ${size} bookmarks, batched mode:`);
        console.log("| Statement | Times | Rows read | Rows written |");
        console.log("| --- | --- | --- | --- |");
        for (const [sql, entry] of rows.byStatement) {
          console.log(`| \`${sql}\` | ${entry.count} | ${entry.read} | ${entry.written} |`);
        }
      }
    }
  } finally {
    await server.close();
  }
  return out;
}

// ---- The run -----------------------------------------------------------------------------------

// The service writes one `Search:` line for each search, which would bury the tables.
console.info = () => {};

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "8,100,500" },
    runs: { type: "string", default: "15" },
  },
});
const sizes = values.sizes.split(",").map(Number);
const runs = Number(values.runs);

console.log(
  `Measured ${new Date().toISOString()} on Node ${process.version}, ${process.platform} ${process.arch}`,
);
console.log(`Collection sizes ${sizes.join(", ")}; ${runs} warm searches each.\n`);

console.log(
  "CPU time (ms) in this process, with the time in SQLite and in the fake Jev taken out:",
);
console.log(
  "| Mode | Bookmarks | Requests to Jev | First search | Warm median | Warm worst | In SQLite (median) |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
let first = true;
for (const mode of ["batched", "pair"] as const) {
  for (const size of sizes) {
    const sqlite = migratedSqlite();
    const db = createDb(sqliteD1(sqlite) as unknown as D1Binding);
    const seeded = await seedCollection(sqliteD1(sqlite), size);
    // The first search of the process pays for the code's first run, as a fresh isolate does.
    const cold = await measureOnce(db, seeded, mode);
    const warm: CpuSample[] = [];
    for (let index = 0; index < runs; index += 1) {
      warm.push(await measureOnce(db, seeded, mode));
    }
    const label = first ? `${fixed(cold.workerMs)} (the process's first)` : fixed(cold.workerMs);
    first = false;
    console.log(
      `| ${mode} | ${size} | ${cold.jevRequests} | ${label} | ${fixed(median(warm.map((s) => s.workerMs)))} | ${fixed(Math.max(...warm.map((s) => s.workerMs)))} | ${fixed(median(warm.map((s) => s.sqliteMs)))} |`,
    );
    sqlite.close();
  }
}

for (const mode of ["batched", "pair"] as const) {
  console.log(`\nD1 rows for one search, ${mode} mode, from the local D1's \`meta\`:`);
  console.log("| Bookmarks | Statements | Rows read | Rows written | Shown |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const [size, rows] of await measureRows(sizes, mode)) {
    console.log(
      `| ${size} | ${rows.statements} | ${rows.read} | ${rows.written} | ${rows.results} |`,
    );
  }
}
globalThis.fetch = realFetch;
