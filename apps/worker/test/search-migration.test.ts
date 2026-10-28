// The migration that adds the search and evaluation tables, applied to a database that already
// holds Milestone 1 and 2 rows, as the production database does. The other tests migrate an
// empty database, so they cannot show that existing rows survive it.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { applyMigration, tableRows } from "./migrations.ts";
import { seedEvalLabel, seedEvalQuery, seedSearchAnswer, seedSearchRun } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker();

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const TABLES = [
  "users",
  "sessions",
  "auth_flows",
  "bookmarks",
  "enrichments",
  "enrichment_failures",
];

describe("the search migration", () => {
  it("leaves Milestone 1 and 2 rows unchanged, and its tables refer to them", async () => {
    const { DB } = await server.getWorker().getEnv();
    await applyMigration(DB, "0000_init.sql");
    await applyMigration(DB, "0001_enrichment.sql");
    // Every column of every table set, so a change to any of them would show.
    await DB.batch([
      DB.prepare(
        "INSERT INTO users (id, google_sub, email, display_name, created_at) VALUES ('user-1', 'sub-1', 'owner@example.com', 'Owner', 1000)",
      ),
      DB.prepare(
        "INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES ('hash-1', 'user-1', 9000, 1001)",
      ),
      DB.prepare(
        "INSERT INTO auth_flows (state_hash, code_verifier, return_to, expires_at, created_at) VALUES ('state-1', 'verifier', '/save', 9000, 1002)",
      ),
      DB.prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, description, canonical_url, captured_title, captured_description, og_title, og_description, og_site_name, sensitive_canonical_dropped, sensitivity_noul, sensitivity_checked_at, sensitivity_acknowledged_at, created_at) VALUES ('bookmark-1', 'user-1', 'https://example.com/A?b=1', 'https://example.com/A?b=1', 'Title', 'Description', 'https://example.com/a', 'Captured title', 'Captured description', 'OG title', 'OG description', 'Example', 0, 0.03, 1004, 1005, 1003)",
      ),
      DB.prepare(
        "INSERT INTO enrichments (id, bookmark_id, schema_version, provider, model, kind, kind_probabilities, data, match_text, match_text_version, created_at) VALUES ('enrichment-1', 'bookmark-1', 1, 'anthropic', 'model', 'article', '{\"article\":0.9}', '{\"summary\":\"A summary\"}', 'Match text', 1, 1006)",
      ),
      DB.prepare(
        "INSERT INTO enrichment_failures (bookmark_id, schema_version, attempts, consecutive_failures, last_error, last_attempt_at) VALUES ('bookmark-1', 2, 1, 2, 'llm:timeout', 1007)",
      ),
    ]);
    const before = await tableRows(DB, TABLES);
    expect(Object.values(before).map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1]);

    await applyMigration(DB, "0002_search_logs_and_eval_labels.sql");

    expect(await tableRows(DB, TABLES)).toEqual(before);
    // The new tables accept rows that refer to the user and the bookmark from before it.
    const runId = await seedSearchRun(DB, "user-1");
    await seedSearchAnswer(DB, runId, "bookmark-1");
    const queryId = await seedEvalQuery(DB, "user-1", "a labeled query");
    await seedEvalLabel(DB, queryId, "bookmark-1", true);
    const answers = await DB.prepare("SELECT search_run_id, bookmark_id FROM search_answers").all();
    expect(answers.results).toEqual([{ search_run_id: runId, bookmark_id: "bookmark-1" }]);
    const labels = await DB.prepare("SELECT eval_query_id, bookmark_id FROM eval_labels").all();
    expect(labels.results).toEqual([{ eval_query_id: queryId, bookmark_id: "bookmark-1" }]);
  });
});
