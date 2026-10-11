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

// Smoke test: the Worker starts and answers. Routes behind the session gate are covered in
// auth.test.ts.
describe("worker", () => {
  it.each([
    ["GET", "/auth/unknown"],
    ["GET", "/auth/callback-not-yet"],
  ])("answers 404 to %s %s", async (method, path) => {
    const response = await server.fetch(path, { method });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
