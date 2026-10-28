import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDb } from "../src/db/client.ts";
import { collectStateInputs, readEnrichmentStateInputs } from "../src/enrichment/state-inputs.ts";
import {
  seedBookmark,
  seedEnrichment,
  seedEnrichmentFailure,
  seedSignedInUser,
  type SeededBookmarkFields,
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

async function d1() {
  return (await server.getWorker().getEnv()).DB;
}

const SCHEMA_VERSION = 2;
let userId: string;

beforeEach(async () => {
  const DB = await d1();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
  ]);
  ({ userId } = await seedSignedInUser(DB, "owner@example.com"));
});

async function save(path: string, fields: SeededBookmarkFields = {}, owner = userId) {
  const url = `https://example.com/${path}`;
  return seedBookmark(await d1(), owner, url, url, fields);
}

async function read(owner = userId) {
  return readEnrichmentStateInputs(createDb(await d1()), owner, SCHEMA_VERSION);
}

describe("readEnrichmentStateInputs", () => {
  it("reads a bookmark with no enrichment and no failure record", async () => {
    const id = await save("a");
    expect(await read()).toEqual([
      {
        bookmarkId: id,
        sensitivityNoul: null,
        sensitivityAcknowledgedAt: null,
        enrichmentVersions: [],
        failure: null,
        failureVersion: SCHEMA_VERSION,
      },
    ]);
  });

  it("reads the sensitivity columns", async () => {
    const id = await save("a", { sensitivityNoul: 0.8, sensitivityAcknowledgedAt: 1_234 });
    expect(await read()).toEqual([
      expect.objectContaining({
        bookmarkId: id,
        sensitivityNoul: 0.8,
        sensitivityAcknowledgedAt: 1_234,
      }),
    ]);
  });

  it("lists the schema version of every enrichment, once per bookmark", async () => {
    const DB = await d1();
    const id = await save("a");
    await seedEnrichment(DB, id, 2);
    await seedEnrichment(DB, id, 1);
    await seedEnrichmentFailure(DB, id, SCHEMA_VERSION, 1);
    const inputs = await read();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.enrichmentVersions).toEqual([1, 2]);
    expect(inputs[0]?.failure).toEqual({ attempts: 1 });
  });

  it("reads the failure record at the given schema version only", async () => {
    const DB = await d1();
    const current = await save("current");
    const older = await save("older");
    await seedEnrichmentFailure(DB, current, SCHEMA_VERSION, 3);
    await seedEnrichmentFailure(DB, older, SCHEMA_VERSION - 1, 3);
    const failures = new Map((await read()).map((inputs) => [inputs.bookmarkId, inputs.failure]));
    expect(failures.get(current)).toEqual({ attempts: 3 });
    expect(failures.get(older)).toBeNull();
  });

  it("reads only the user's bookmarks, oldest first", async () => {
    const DB = await d1();
    const second = await seedSignedInUser(DB, "second@example.com");
    const newest = await save("newest", { createdAt: 3_000 });
    const oldest = await save("oldest", { createdAt: 1_000 });
    const theirs = await save("theirs", { createdAt: 2_000 }, second.userId);
    await seedEnrichment(DB, theirs, SCHEMA_VERSION);
    expect((await read()).map((inputs) => inputs.bookmarkId)).toEqual([oldest, newest]);
    expect((await read(second.userId)).map((inputs) => inputs.enrichmentVersions)).toEqual([
      [SCHEMA_VERSION],
    ]);
  });

  it("reads nothing for a user with no bookmarks", async () => {
    expect(await read()).toEqual([]);
  });
});

describe("collectStateInputs", () => {
  // The sweep's query selects the backoff columns as well.
  const row = {
    bookmarkId: "bookmark-1",
    sensitivityNoul: 0.2,
    sensitivityAcknowledgedAt: null,
    enrichmentVersion: 1,
    failedAttempts: 0,
    consecutiveFailures: 4,
  };

  it("keeps the other columns the query selected, once per bookmark", () => {
    expect(
      collectStateInputs(
        [row, { ...row, enrichmentVersion: 2 }, { ...row, bookmarkId: "bookmark-2" }],
        3,
      ),
    ).toEqual([
      {
        bookmarkId: "bookmark-1",
        sensitivityNoul: 0.2,
        sensitivityAcknowledgedAt: null,
        enrichmentVersions: [1, 2],
        failure: { attempts: 0 },
        failureVersion: 3,
        consecutiveFailures: 4,
      },
      {
        bookmarkId: "bookmark-2",
        sensitivityNoul: 0.2,
        sensitivityAcknowledgedAt: null,
        enrichmentVersions: [1],
        failure: { attempts: 0 },
        failureVersion: 3,
        consecutiveFailures: 4,
      },
    ]);
  });
});
