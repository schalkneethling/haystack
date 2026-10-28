import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  seedBookmark,
  seedEnrichment,
  seedEnrichmentFailure,
  seedEvalLabel,
  seedEvalQuery,
  seedSearchAnswer,
  seedSearchRun,
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

async function insertUser(): Promise<string> {
  const { DB } = await server.getWorker().getEnv();
  const userId = crypto.randomUUID();
  await DB.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `sub-${userId}`, "user@example.com", Date.now())
    .run();
  return userId;
}

describe("migrated database", () => {
  it("contains the Milestone 1, enrichment, search and evaluation tables", async () => {
    const { DB } = await server.getWorker().getEnv();
    const { results } = await DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'sessions', 'auth_flows', 'bookmarks', 'enrichments', 'enrichment_failures', 'search_runs', 'search_answers', 'eval_queries', 'eval_labels') ORDER BY name",
    ).all();

    expect(results.map((row: { name: string }) => row.name)).toEqual([
      "auth_flows",
      "bookmarks",
      "enrichment_failures",
      "enrichments",
      "eval_labels",
      "eval_queries",
      "search_answers",
      "search_runs",
      "sessions",
      "users",
    ]);
  });

  it("deletes a user's sessions when the user is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const now = Date.now();
    const selectSessions = DB.prepare("SELECT id_hash FROM sessions WHERE user_id = ?").bind(
      userId,
    );

    await DB.prepare(
      "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(`hash-${userId}`, userId, now + 60_000, now)
      .run();
    expect((await selectSessions.all()).results).toHaveLength(1);

    await DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    expect((await selectSessions.all()).results).toEqual([]);
  });

  it("refuses to delete a user who still has bookmarks", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();

    await DB.prepare(
      "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        userId,
        "https://example.com/",
        "https://example.com/",
        "Example",
        Date.now(),
      )
      .run();

    await expect(DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );

    const bookmarks = await DB.prepare("SELECT id FROM bookmarks WHERE user_id = ?")
      .bind(userId)
      .all();
    expect(bookmarks.results).toHaveLength(1);
  });

  it("deletes a bookmark's enrichments and failure records when the bookmark is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const url = "https://example.com/enriched";
    const bookmarkId = await seedBookmark(DB, userId, url, url);
    const otherUrl = "https://example.com/kept";
    const otherId = await seedBookmark(DB, userId, otherUrl, otherUrl);
    for (const id of [bookmarkId, otherId]) {
      await seedEnrichment(DB, id, 1);
      await seedEnrichmentFailure(DB, id, 2, 1);
    }
    const rowsOf = async (id: string) => ({
      enrichments: (
        await DB.prepare("SELECT id FROM enrichments WHERE bookmark_id = ?").bind(id).all()
      ).results.length,
      failures: (
        await DB.prepare("SELECT schema_version FROM enrichment_failures WHERE bookmark_id = ?")
          .bind(id)
          .all()
      ).results.length,
    });
    expect(await rowsOf(bookmarkId)).toEqual({ enrichments: 1, failures: 1 });

    await DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(bookmarkId).run();

    expect(await rowsOf(bookmarkId)).toEqual({ enrichments: 0, failures: 0 });
    expect(await rowsOf(otherId)).toEqual({ enrichments: 1, failures: 1 });
  });

  it("deletes a bookmark's search answers and keeps the run when the bookmark is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const deletedUrl = "https://example.com/answered";
    const deletedId = await seedBookmark(DB, userId, deletedUrl, deletedUrl);
    const keptUrl = "https://example.com/also-answered";
    const keptId = await seedBookmark(DB, userId, keptUrl, keptUrl);
    const runId = await seedSearchRun(DB, userId);
    await seedSearchAnswer(DB, runId, deletedId);
    await seedSearchAnswer(DB, runId, keptId);

    await DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(deletedId).run();

    const answers = await DB.prepare(
      "SELECT bookmark_id FROM search_answers WHERE search_run_id = ?",
    )
      .bind(runId)
      .all();
    expect(answers.results).toEqual([{ bookmark_id: keptId }]);
    const runs = await DB.prepare("SELECT id FROM search_runs WHERE id = ?").bind(runId).all();
    expect(runs.results).toHaveLength(1);
  });

  it("deletes a run's answers when the run is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const url = "https://example.com/answered";
    const bookmarkId = await seedBookmark(DB, userId, url, url);
    const deletedRunId = await seedSearchRun(DB, userId);
    const keptRunId = await seedSearchRun(DB, userId);
    for (const runId of [deletedRunId, keptRunId]) {
      await seedSearchAnswer(DB, runId, bookmarkId);
    }

    await DB.prepare("DELETE FROM search_runs WHERE id = ?").bind(deletedRunId).run();

    const answers = await DB.prepare(
      "SELECT search_run_id FROM search_answers WHERE bookmark_id = ?",
    )
      .bind(bookmarkId)
      .all();
    expect(answers.results).toEqual([{ search_run_id: keptRunId }]);
  });

  it("refuses to delete a user who still has search runs", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    await seedSearchRun(DB, userId);

    await expect(DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );

    const runs = await DB.prepare("SELECT id FROM search_runs WHERE user_id = ?")
      .bind(userId)
      .all();
    expect(runs.results).toHaveLength(1);
  });

  it("refuses to delete a user who still has labeled queries", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    await seedEvalQuery(DB, userId, "a query");

    await expect(DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("deletes a bookmark's labels and keeps the query when the bookmark is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const deletedUrl = "https://example.com/labeled";
    const deletedId = await seedBookmark(DB, userId, deletedUrl, deletedUrl);
    const keptUrl = "https://example.com/also-labeled";
    const keptId = await seedBookmark(DB, userId, keptUrl, keptUrl);
    const queryId = await seedEvalQuery(DB, userId, "a query");
    await seedEvalLabel(DB, queryId, deletedId, true);
    await seedEvalLabel(DB, queryId, keptId, false);

    await DB.prepare("DELETE FROM bookmarks WHERE id = ?").bind(deletedId).run();

    const labels = await DB.prepare("SELECT bookmark_id FROM eval_labels WHERE eval_query_id = ?")
      .bind(queryId)
      .all();
    expect(labels.results).toEqual([{ bookmark_id: keptId }]);
    const queries = await DB.prepare("SELECT id FROM eval_queries WHERE id = ?")
      .bind(queryId)
      .all();
    expect(queries.results).toHaveLength(1);
  });

  it("deletes a labeled query's labels when the query is deleted", async () => {
    const { DB } = await server.getWorker().getEnv();
    const userId = await insertUser();
    const url = "https://example.com/labeled";
    const bookmarkId = await seedBookmark(DB, userId, url, url);
    const deletedQueryId = await seedEvalQuery(DB, userId, "a deleted query");
    const keptQueryId = await seedEvalQuery(DB, userId, "a kept query");
    for (const queryId of [deletedQueryId, keptQueryId]) {
      await seedEvalLabel(DB, queryId, bookmarkId, true);
    }

    await DB.prepare("DELETE FROM eval_queries WHERE id = ?").bind(deletedQueryId).run();

    const labels = await DB.prepare("SELECT eval_query_id FROM eval_labels WHERE bookmark_id = ?")
      .bind(bookmarkId)
      .all();
    expect(labels.results).toEqual([{ eval_query_id: keptQueryId }]);
  });
});
