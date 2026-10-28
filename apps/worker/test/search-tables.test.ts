// The tables that log every search, and the evaluation labels, as the migrations create them.
// See "Data model" in plans/haystack-v1-implementation-plan.md. What deleting a row removes is
// in db.test.ts, next to the other deletion tests.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  seedBookmark,
  seedEvalLabel,
  seedEvalQuery,
  seedSearchAnswer,
  seedSearchRun,
  type SeededSearchRunFields,
} from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker();

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

async function insertUser(): Promise<string> {
  const DB = await d1();
  const userId = crypto.randomUUID();
  await DB.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `sub-${userId}`, "user@example.com", Date.now())
    .run();
  return userId;
}

async function insertBookmark(userId: string): Promise<string> {
  const url = `https://example.com/${crypto.randomUUID()}`;
  return seedBookmark(await d1(), userId, url, url);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

// Each column as `PRAGMA table_info` reports it: its name, type, whether it is NOT NULL, its
// default, and its place in the primary key (0 when it is not part of it).
async function columns(table: string) {
  const { results } = await (await d1()).prepare(`PRAGMA table_info(${table})`).all();
  return (results as ColumnInfo[]).map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type,
    notNull: notnull === 1,
    default: dflt_value,
    pk,
  }));
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

async function foreignKeys(table: string) {
  const { results } = await (await d1()).prepare(`PRAGMA foreign_key_list(${table})`).all();
  return (results as ForeignKeyInfo[])
    .map(({ table: references, from, to, on_delete }) => ({
      from,
      references: `${references}(${to})`,
      onDelete: on_delete,
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

function column(name: string, type: string, notNull: boolean, pk = 0, defaultValue = null) {
  return { name, type, notNull, default: defaultValue, pk };
}

describe("search_runs", () => {
  it("has the plan's columns and keys", async () => {
    expect(await columns("search_runs")).toEqual([
      column("id", "TEXT", true, 1),
      column("user_id", "TEXT", true),
      column("query", "TEXT", true),
      column("channel", "TEXT", true),
      column("input_mode", "TEXT", false),
      column("request_mode", "TEXT", true),
      column("jev_model", "TEXT", true),
      column("questions", "TEXT", true),
      column("display_signal", "TEXT", true),
      column("noul_threshold", "REAL", true),
      column("score_threshold", "REAL", true),
      column("input_tokens", "INTEGER", false),
      column("latency_ms", "INTEGER", false),
      column("outcome", "TEXT", true),
      column("error", "TEXT", false),
      column("created_at", "INTEGER", true),
    ]);
    // No ON DELETE: a user who still has search runs cannot be deleted (db.test.ts).
    expect(await foreignKeys("search_runs")).toEqual([
      { from: "user_id", references: "users(id)", onDelete: "NO ACTION" },
    ]);
  });

  // Each CHECK constraint, with every value it accepts and one it refuses.
  const constrained: {
    field: keyof Omit<SeededSearchRunFields, "createdAt">;
    accepted: (string | null)[];
    refused: string;
  }[] = [
    { field: "channel", accepted: ["web", "webmcp", "mcp", "eval"], refused: "other" },
    // input_mode is empty for every channel but the web.
    { field: "inputMode", accepted: ["typed", "web-speech", "whisper", null], refused: "voice" },
    { field: "requestMode", accepted: ["pair", "batched"], refused: "single" },
    { field: "questions", accepted: ["both", "noul", "score"], refused: "neither" },
    { field: "displaySignal", accepted: ["noul", "score"], refused: "both" },
    { field: "outcome", accepted: ["ok", "partial", "failed"], refused: "cancelled" },
  ];

  it.each(constrained)("accepts every allowed $field", async ({ field, accepted }) => {
    const DB = await d1();
    const userId = await insertUser();
    for (const value of accepted) {
      await seedSearchRun(DB, userId, { [field]: value });
    }
    const { results } = await DB.prepare("SELECT id FROM search_runs WHERE user_id = ?")
      .bind(userId)
      .all();
    expect(results).toHaveLength(accepted.length);
  });

  it.each(constrained)("refuses a $field of $refused", async ({ field, refused }) => {
    const DB = await d1();
    const userId = await insertUser();
    await expect(seedSearchRun(DB, userId, { [field]: refused })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe("search_answers", () => {
  it("has the plan's columns and keys, with each signal's columns nullable", async () => {
    expect(await columns("search_answers")).toEqual([
      column("search_run_id", "TEXT", true, 1),
      column("bookmark_id", "TEXT", true, 2),
      column("noul", "REAL", false),
      column("score", "REAL", false),
      column("score_probabilities", "TEXT", false),
      column("score_confidence", "REAL", false),
      column("shown", "INTEGER", true),
      { ...column("clicked", "INTEGER", true), default: "false" },
    ]);
    expect(await foreignKeys("search_answers")).toEqual([
      { from: "bookmark_id", references: "bookmarks(id)", onDelete: "CASCADE" },
      { from: "search_run_id", references: "search_runs(id)", onDelete: "CASCADE" },
    ]);
  });

  it("stores an answer with only a Noul and one with only a Score, not yet clicked", async () => {
    const DB = await d1();
    const userId = await insertUser();
    const noulOnly = await insertBookmark(userId);
    const scoreOnly = await insertBookmark(userId);
    const runId = await seedSearchRun(DB, userId);

    await seedSearchAnswer(DB, runId, noulOnly, {
      noul: 0.9,
      score: null,
      scoreProbabilities: null,
      scoreConfidence: null,
    });
    await seedSearchAnswer(DB, runId, scoreOnly, { noul: null, score: 2.3 });

    const answer = (bookmarkId: string) =>
      DB.prepare(
        "SELECT noul, score, score_probabilities, score_confidence, clicked FROM search_answers WHERE search_run_id = ? AND bookmark_id = ?",
      )
        .bind(runId, bookmarkId)
        .first();
    expect(await answer(noulOnly)).toEqual({
      noul: 0.9,
      score: null,
      score_probabilities: null,
      score_confidence: null,
      clicked: 0,
    });
    expect(await answer(scoreOnly)).toEqual({
      noul: null,
      score: 2.3,
      score_probabilities: '{"0":0.1,"1":0.1,"2":0.2,"3":0.6}',
      score_confidence: 0.7,
      clicked: 0,
    });
  });

  it.each([
    { missing: "score", fields: { score: null } },
    { missing: "score_probabilities", fields: { scoreProbabilities: null } },
    { missing: "score_confidence", fields: { scoreConfidence: null } },
  ])("refuses a Score answer without its $missing", async ({ fields }) => {
    const DB = await d1();
    const userId = await insertUser();
    const bookmarkId = await insertBookmark(userId);
    const runId = await seedSearchRun(DB, userId);

    await expect(seedSearchAnswer(DB, runId, bookmarkId, fields)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("refuses a second answer from one run for the same bookmark", async () => {
    const DB = await d1();
    const userId = await insertUser();
    const bookmarkId = await insertBookmark(userId);
    const runId = await seedSearchRun(DB, userId);
    await seedSearchAnswer(DB, runId, bookmarkId);

    await expect(seedSearchAnswer(DB, runId, bookmarkId)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });
});

describe("eval_queries and eval_labels", () => {
  it("store each query once, and a label refers to it", async () => {
    expect(await columns("eval_queries")).toEqual([
      column("id", "TEXT", true, 1),
      column("user_id", "TEXT", true),
      column("query", "TEXT", true),
      column("created_at", "INTEGER", true),
    ]);
    expect(await foreignKeys("eval_queries")).toEqual([
      { from: "user_id", references: "users(id)", onDelete: "NO ACTION" },
    ]);
    expect(await columns("eval_labels")).toEqual([
      column("eval_query_id", "TEXT", true, 1),
      column("bookmark_id", "TEXT", true, 2),
      column("relevant", "INTEGER", true),
      column("labeled_at", "INTEGER", true),
    ]);
    expect(await foreignKeys("eval_labels")).toEqual([
      { from: "bookmark_id", references: "bookmarks(id)", onDelete: "CASCADE" },
      { from: "eval_query_id", references: "eval_queries(id)", onDelete: "CASCADE" },
    ]);
  });

  it("refuse the same query twice for one user, and allow it for another", async () => {
    const DB = await d1();
    const userId = await insertUser();
    await seedEvalQuery(DB, userId, "css grid layout");

    await expect(seedEvalQuery(DB, userId, "css grid layout")).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(seedEvalQuery(DB, await insertUser(), "css grid layout")).resolves.toBeTypeOf(
      "string",
    );
  });

  it("refuse a second label for the same query and bookmark", async () => {
    const DB = await d1();
    const userId = await insertUser();
    const bookmarkId = await insertBookmark(userId);
    const queryId = await seedEvalQuery(DB, userId, "a query");
    await seedEvalLabel(DB, queryId, bookmarkId, true);

    // So a bookmark can't be both a match and a non-match for one query.
    await expect(seedEvalLabel(DB, queryId, bookmarkId, false)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("refuse a label for a bookmark that doesn't exist", async () => {
    const DB = await d1();
    const queryId = await seedEvalQuery(DB, await insertUser(), "a query");

    await expect(seedEvalLabel(DB, queryId, crypto.randomUUID(), true)).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
