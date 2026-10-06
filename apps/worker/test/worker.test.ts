import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe("worker", () => {
  it.each([
    ["GET", "/"],
    ["GET", "/save?url=https://example.com/"],
    ["GET", "/auth/callback"],
    ["POST", "/bookmarks/1/delete"],
  ])("answers 404 to %s %s while no routes exist", async (method, path) => {
    const response = await server.fetch(path, { method });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
