import { mkdtempDisposable, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBuilder } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));
// A build points Wrangler at its output through this file. The test restores it afterwards,
// so later Wrangler commands are not redirected to the deleted temporary build.
const deployRedirect = join(root, ".wrangler", "deploy", "config.json");

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function buildFiles(outDir: string): Promise<string[]> {
  const previousRedirect = await readIfExists(deployRedirect);
  try {
    const builder = await createBuilder({ root, logLevel: "silent", build: { outDir } });
    await builder.buildApp();
    return await readdir(outDir, { recursive: true });
  } finally {
    if (previousRedirect === undefined) {
      await rm(deployRedirect, { force: true });
    } else {
      await writeFile(deployRedirect, previousRedirect);
    }
  }
}

describe("build output", () => {
  // Decision 1: every HTML page goes through the Worker, so no HTML may be a static asset.
  it("contains no HTML files", async () => {
    await using outDir = await mkdtempDisposable(join(tmpdir(), "haystack-build-"));
    const files = await buildFiles(outDir.path);

    expect(files.filter((file) => file.endsWith(".html"))).toEqual([]);
  });
});
