import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});

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
  it("contains the Milestone 1 tables", async () => {
    const { DB } = await server.getWorker().getEnv();
    const { results } = await DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'sessions', 'auth_flows', 'bookmarks') ORDER BY name",
    ).all();

    expect(results.map((row: { name: string }) => row.name)).toEqual([
      "auth_flows",
      "bookmarks",
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
});
