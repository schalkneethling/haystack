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

// Smoke test: the Worker starts and answers, with and without touching D1. Routes behind the
// session gate are covered in auth.test.ts.
describe("worker", () => {
  it("answers 404 to an unknown /auth/* route", async () => {
    const response = await server.fetch("/auth/unknown");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<h1>Page not found</h1>");
  });

  it("looks up a session cookie in D1", async () => {
    await server.getWorker().applyD1Migrations("DB");
    const response = await server.fetch("/api/search", {
      headers: { cookie: "__Host-session=unknown" },
    });

    expect(response.status).toBe(401);
  });
});
