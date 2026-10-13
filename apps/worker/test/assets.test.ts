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

describe("static assets", () => {
  // The list page loads this script, and the CSP allows scripts from this origin only.
  it("serves the delete dialog script as JavaScript, with nosniff and no session", async () => {
    const response = await server.fetch("/assets/delete-dialog.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("showModal");
  });

  it("does not serve the headers file itself", async () => {
    // It falls through to the Worker, which refuses a request without a session.
    const response = await server.fetch("/_headers");
    expect(response.status).toBe(401);
  });
});
