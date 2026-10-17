import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";
import webExt from "web-ext";
import { buildExtension } from "../build.ts";

// The warnings that are known not to be a problem with Haystack's manifest. Keep this list short,
// because every code on it hides a real problem of that kind. A later web-ext update may add
// warnings that fail the test, and each one needs a look: it is either a real gap in the manifest
// or another entry for this list.
const ACCEPTED_WARNINGS = new Set([
  // A limit of addons-linter. When the manifest has no `gecko_android` key, it takes Firefox for
  // Android's minimum version from `gecko.strict_min_version` (140), and warns that Android 140
  // can't show the data consent the manifest declares. Without that key, Firefox offers the
  // add-on on desktop only, so the warning is about a version Haystack is never installed on.
  "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
]);

function format({ code, message }: { code: string; message: string }): string {
  return `${code}: ${message}`;
}

// Linting the Firefox build checks Haystack's manifest against the rules addons.mozilla.org applies
// when the add-on is signed (Phase 6), so a bad key fails here, not at submission. Any error
// fails the test, and so does any warning that is not accepted above. addons-linter only reads the
// files, and makes no network request.
it("has no errors and no unexpected warnings from web-ext lint", { timeout: 30_000 }, async () => {
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

  expect(errors.map(format)).toEqual([]);
  expect(warnings.filter(({ code }) => !ACCEPTED_WARNINGS.has(code)).map(format)).toEqual([]);
});
