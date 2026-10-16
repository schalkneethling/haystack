import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";
import webExt from "web-ext";
import { buildExtension } from "../build.ts";

// Linting the Firefox build checks Haystack's manifest against the rules addons.mozilla.org applies
// when the add-on is signed (Phase 6), so a bad key fails here, not at submission. Warnings fail
// the test too: the manifest is small, every warning addons-linter has given it so far was a real
// gap (for example Android 140 can't show the data consent the manifest declares), and the
// message names the key to fix. addons-linter only reads the files, and makes no network request.
it("has no errors and no warnings from web-ext lint", { timeout: 30_000 }, async () => {
  await using workDir = await mkdtempDisposable(join(tmpdir(), "haystack-extension-"));
  const sourceDir = join(workDir.path, "firefox");
  await buildExtension({
    origin: "https://haystack.example",
    browser: "firefox",
    outDir: sourceDir,
  });

  const { errors, warnings } = await webExt.cmd.lint(
    { sourceDir, artifactsDir: join(workDir.path, "artifacts"), output: "none" },
    // Without this, web-ext exits the test process when the lint finishes.
    { shouldExitProgram: false },
  );

  const describe = ({ code, message }: { code: string; message: string }) => `${code}: ${message}`;
  expect(errors.map(describe)).toEqual([]);
  expect(warnings.map(describe)).toEqual([]);
});
