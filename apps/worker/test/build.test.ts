import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));
let outDir = "";
let files: string[] = [];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "haystack-build-"));
  const builder = await createBuilder({ root, logLevel: "silent", build: { outDir } });
  await builder.buildApp();
  files = await readdir(outDir, { recursive: true });
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("build output", () => {
  it("contains the Worker bundle", () => {
    expect(files).toContain(join("haystack", "index.js"));
  });

  // Decision 1: every HTML page goes through the Worker, so no HTML may be a static asset.
  it("contains no HTML files", () => {
    expect(files.filter((file) => file.endsWith(".html"))).toEqual([]);
  });
});
