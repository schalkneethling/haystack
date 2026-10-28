// The enrichment migration applied to a database that already holds Milestone 1 rows, as the
// production database does. The other tests migrate an empty database, so they cannot show
// that existing rows survive it.
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker();

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

// Runs one migration file as a single batch, split into statements where drizzle-kit marks
// the breaks. This test applies the files itself, rather than with `applyD1Migrations`,
// because it needs rows in the database between the two migrations.
async function applyMigration(name: string): Promise<void> {
  const DB = await d1();
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  await DB.batch(statements.map((statement) => DB.prepare(statement)));
}

const TABLES = ["users", "sessions", "auth_flows", "bookmarks"];

type Row = Record<string, unknown>;

async function rows(): Promise<Record<string, Row[]>> {
  const DB = await d1();
  const entries = await Promise.all(
    TABLES.map(async (table) => {
      const { results } = await DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      return [table, results] as const;
    }),
  );
  return Object.fromEntries(entries);
}

describe("the enrichment migration", () => {
  it("leaves Milestone 1 rows unchanged, with the new column NULL", async () => {
    await applyMigration("0000_init.sql");
    const DB = await d1();
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
      // Every Milestone 1 column set, so a change to any of them would show.
      DB.prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, description, canonical_url, captured_title, captured_description, og_title, og_description, og_site_name, created_at) VALUES ('bookmark-1', 'user-1', 'https://example.com/A?b=1', 'https://example.com/A?b=1', 'Title', 'Description', 'https://example.com/a', 'Captured title', 'Captured description', 'OG title', 'OG description', 'Example', 1003)",
      ),
      DB.prepare(
        "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, created_at) VALUES ('bookmark-2', 'user-1', 'https://example.com/', 'https://example.com', 'Home', 1004)",
      ),
    ]);
    const before = await rows();

    await applyMigration("0001_enrichment.sql");

    const { bookmarks: bookmarksBefore = [], ...othersBefore } = before;
    const { bookmarks: bookmarksAfter = [], ...othersAfter } = await rows();
    expect(othersAfter).toEqual(othersBefore);
    expect(bookmarksBefore).toHaveLength(2);
    expect(bookmarksAfter).toEqual(
      bookmarksBefore.map((row) => ({ ...row, sensitive_canonical_dropped: null })),
    );
  });
});
