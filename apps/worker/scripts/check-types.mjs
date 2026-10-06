// Fails when worker-configuration.d.ts differs from what `wrangler types` generates now.
// `wrangler types --check` compares only the header, so a hand edit to the body would pass it.
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

const committedPath = "worker-configuration.d.ts";
// Generated next to the committed file, because the output contains import paths relative to it.
const freshPath = "worker-configuration.check.d.ts";
// Line 2 records the command and a hash, which differ for any output path.
const withoutCommandLine = (text) => text.split("\n").toSpliced(1, 1).join("\n");

try {
  execFileSync("wrangler", ["types", freshPath], { stdio: "ignore" });
  const [committed, fresh] = await Promise.all([
    readFile(committedPath, "utf8"),
    readFile(freshPath, "utf8"),
  ]);
  if (withoutCommandLine(committed) !== withoutCommandLine(fresh)) {
    console.error(
      `${committedPath} is out of date. Run \`vp run --filter @haystack/worker types\` and commit the result.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${committedPath} is up to date.`);
  }
} finally {
  await rm(freshPath, { force: true });
}
