/**
 * The vite alias check: fails when the `vite` alias in pnpm-workspace.yaml's catalog
 * names a different `@voidzero-dev/vite-plus-core` version than `vite-plus`, and says
 * what to change.
 *
 * Vite+ needs `vite` to resolve to the core package of its own version, so the catalog
 * pins `vite: npm:@voidzero-dev/vite-plus-core@<version>` next to `vite-plus: <version>`.
 * Dependabot bumps only `vite-plus` and leaves the alias behind (commit eaa3bad, 1.1.0
 * to 1.4.0), which installs two copies of Vite and fails the type check of
 * apps/worker/vite.config.ts. CI runs this check before installing anything, so such a
 * pull request fails in seconds with the fix in the message. Locally:
 * `node scripts/check-vite-alias.ts`.
 *
 * The decision logic is a pure function of the file's text, tested without touching the
 * real file. Only `main` reads it. The file is read line by line instead of with a YAML
 * parser, because this check runs before dependencies are installed.
 */

import { readFileSync } from "node:fs";

/** The package that `vite` must be an alias for. */
const CORE_PACKAGE = "@voidzero-dev/vite-plus-core";

/**
 * An exact version, such as `1.4.0` or `1.5.0-beta.1`. The alias must name one
 * version, so a range in `vite-plus` cannot be copied into it.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** What the check decided. `line` is the catalog's `vite-plus` line, when found. */
export type CheckOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; line?: number };

/** A catalog entry's value and its 1-based line in the file. */
type Entry = { value: string; line: number };

/** The alias value that matches a given `vite-plus` version. */
export function expectedAlias(version: string): string {
  return `npm:${CORE_PACKAGE}@${version}`;
}

/** Removes a trailing comment and the quotes around a YAML scalar. */
function scalar(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, "").trim();
  return withoutComment.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Reads the entries of the top-level `catalog:` mapping, keyed by package name. Only
 * lines indented under `catalog:` count, so `overrides:` entries such as `vite@*` are
 * never mistaken for catalog entries.
 */
function readCatalog(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  let inCatalog = false;
  text.split("\n").forEach((rawLine, index) => {
    if (/^catalog:\s*(?:#.*)?$/.test(rawLine)) {
      inCatalog = true;
      return;
    }
    if (!inCatalog || rawLine.trim() === "" || /^\s*#/.test(rawLine)) return;
    if (!/^\s/.test(rawLine)) {
      inCatalog = false;
      return;
    }
    const match = /^\s+("[^"]+"|'[^']+'|[^\s:]+)\s*:\s*(.*)$/.exec(rawLine);
    if (match?.[1] === undefined || match[2] === undefined) return;
    entries.set(scalar(match[1]), { value: scalar(match[2]), line: index + 1 });
  });
  return entries;
}

/** Decides from pnpm-workspace.yaml's text whether the catalog's alias matches `vite-plus`. */
export function evaluateWorkspace(text: string): CheckOutcome {
  const catalog = readCatalog(text);
  const vitePlus = catalog.get("vite-plus");
  if (vitePlus === undefined) {
    return { ok: false, message: "pnpm-workspace.yaml has no `vite-plus` entry in its catalog." };
  }
  const version = vitePlus.value;
  if (!EXACT_VERSION.test(version)) {
    return {
      ok: false,
      line: vitePlus.line,
      message:
        `pnpm-workspace.yaml gives vite-plus as "${version}", which is not an exact version. ` +
        "Pin vite-plus to one version, such as 1.4.0, so the vite alias can name the same version.",
    };
  }

  const expected = expectedAlias(version);
  const actual = catalog.get("vite")?.value;
  if (actual === expected) {
    return { ok: true, message: `The vite alias matches vite-plus ${version}.` };
  }
  return {
    ok: false,
    line: vitePlus.line,
    message:
      `pnpm-workspace.yaml pins vite-plus ${version}, but ` +
      `${actual === undefined ? "the catalog has no `vite` entry" : `the vite alias is "${actual}"`}. ` +
      "Vite+ needs both to name the same version, or the build installs two copies of Vite. " +
      `Set \`vite: ${expected}\` in the catalog, run \`vp install\`, ` +
      "and commit pnpm-workspace.yaml and pnpm-lock.yaml.",
  };
}

/**
 * Formats a failure as a GitHub Actions error annotation, escaped the way
 * `@actions/core` escapes command data and properties (packages/core/src/command.ts
 * in actions/toolkit).
 */
export function annotation(message: string, line?: number): string {
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const properties = ["file=pnpm-workspace.yaml", ...(line === undefined ? [] : [`line=${line}`])];
  return `::error ${properties.join(",")},title=vite alias out of step::${data}`;
}

/**
 * Runs the check on the given pnpm-workspace.yaml text, prints the outcome, and returns
 * the process exit code. Inside GitHub Actions a failure is also printed as an
 * annotation, so it shows on the pull request.
 */
export function main(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const outcome = evaluateWorkspace(text);
  if (outcome.ok) {
    console.log(outcome.message);
    return 0;
  }
  console.error(
    env["GITHUB_ACTIONS"] === "true" ? annotation(outcome.message, outcome.line) : outcome.message,
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"));
}
