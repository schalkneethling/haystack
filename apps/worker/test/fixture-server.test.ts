// The local fixture server for Phase 8's acceptance run (fixture-server.ts, #128): the
// sweep's clients accept its answers, through both LLM providers and GitHub, so a change to a
// client's schema that the server no longer meets fails here rather than in the next acceptance
// run. The server listens on a loopback port, and the sweep runs in this process against the
// real local D1 from Wrangler's test harness, so no request leaves this machine.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDb, type Db } from "../src/db/client.ts";
import type { EnrichmentConfig } from "../src/enrichment/enrich-bookmark.ts";
import { enrichPending } from "../src/enrichment/enrich-pending.ts";
import { createFixtureServer } from "./fixture-server.ts";
import { seedBookmark, seedSignedInUser } from "./seed.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker();
const requests: string[] = [];
const fixtureServer = createFixtureServer((line) => requests.push(line));

let db: Db;
let config: EnrichmentConfig;
let userId: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  const env = await server.getWorker().getEnv();
  db = createDb(env.DB);
  config = {
    SENSITIVE_WARN_THRESHOLD: env.SENSITIVE_WARN_THRESHOLD,
    JEV_BASE_URL: origin,
    JEV_MODEL: env.JEV_MODEL,
    TYPESAFE_API_KEY: "ts-fixture-key",
    GITHUB_API_BASE_URL: origin,
    GITHUB_TOKEN: "github_pat_fixture",
    ENRICHMENT_PROVIDER: env.ENRICHMENT_PROVIDER,
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    ANTHROPIC_API_KEY: "sk-ant-fixture-key",
    AI_GATEWAY_BASE_URL: origin,
    AI_GATEWAY_ACCOUNT_ID: env.AI_GATEWAY_ACCOUNT_ID,
    AI_GATEWAY_ID: env.AI_GATEWAY_ID,
    AI_GATEWAY_TOKEN: "cf-aig-fixture-token",
  };
});

afterAll(async () => {
  await new Promise((resolve) => fixtureServer.close(resolve));
  await server.close();
});

beforeEach(async () => {
  requests.length = 0;
  const DB = (await server.getWorker().getEnv()).DB;
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  ({ userId } = await seedSignedInUser(DB, "owner@example.com"));
  const start = Date.now() - 60_000;
  for (const [index, url] of [
    "https://github.com/vitest-dev/vitest",
    "https://fixture.example/article",
  ].entries()) {
    await seedBookmark(DB, userId, url, url, { createdAt: start + index * 1000 });
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("the fixture server", () => {
  it.each(["anthropic", "ai-gateway"])(
    "answers every request of a sweep through %s in a way the clients accept",
    async (provider) => {
      const summary = await enrichPending(db, { ...config, ENRICHMENT_PROVIDER: provider });

      expect(summary).toMatchObject({ selected: 2, enriched: 2, failed: 0, stopped: null });
      // Each bookmark's sensitivity and `kind` questions and its LLM request, and the GitHub
      // bookmark's repository and README, each answered once, with nothing unplanned.
      expect(requests).toHaveLength(8);
      expect(requests.every((line) => line.endsWith(" 200"))).toBe(true);
      expect(requests).toContain("GET /repos/vitest-dev/vitest 200");
      expect(requests).toContain("GET /repos/vitest-dev/vitest/readme 200");
    },
  );

  it("answers a request it has no fixture for with a 404 it logs", async () => {
    const origin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;

    const response = await fetch(`${origin}/v1/unknown`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(requests).toEqual(["POST /v1/unknown 404 (unplanned)"]);
  });
});
