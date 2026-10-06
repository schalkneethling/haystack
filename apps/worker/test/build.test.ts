import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));
// A build points Wrangler at its output through this file. The test restores it afterwards,
// so later Wrangler commands are not redirected to the deleted temporary build.
const deployRedirect = join(root, ".wrangler", "deploy", "config.json");
let previousRedirect: string | undefined;
let outDir = "";
let files: string[] = [];

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

beforeAll(async () => {
  previousRedirect = await readIfExists(deployRedirect);
  outDir = await mkdtemp(join(tmpdir(), "haystack-build-"));
  const builder = await createBuilder({ root, logLevel: "silent", build: { outDir } });
  await builder.buildApp();
  files = await readdir(outDir, { recursive: true });
});

afterAll(async () => {
  if (previousRedirect === undefined) {
    await rm(deployRedirect, { force: true });
  } else {
    await writeFile(deployRedirect, previousRedirect);
  }
  if (outDir) await rm(outDir, { recursive: true, force: true });
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
