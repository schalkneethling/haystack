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
  it("answers 404 while no routes exist", async () => {
    const response = await server.fetch("/");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
