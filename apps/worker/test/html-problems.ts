// Validates markup with html-validate and the repository's .htmlvalidate.json (#3), for the
// integration tests (validate-html.ts) and for the browser tests, which validate markup that a
// page's script builds, such as the search page's states (#207). It has no test runner's
// `expect`, so either runner can import it. The config is found by walking up from the filename,
// as the CLI does.
import { fileURLToPath } from "node:url";
import { FileSystemConfigLoader, HtmlValidate } from "html-validate";

const loader = new FileSystemConfigLoader();
const validator = new HtmlValidate(loader);
const filename = fileURLToPath(new URL("./rendered.html", import.meta.url));

// Without a config, html-validate runs no rules and every page passes. `missing-doctype` comes
// from `html-validate:document`, which .htmlvalidate.json extends.
async function assertConfigFound(): Promise<void> {
  const rules = (await loader.getConfigFor(filename)).getRules();
  if ((rules.get("missing-doctype")?.[0] ?? 0) === 0) {
    throw new Error(`No .htmlvalidate.json found for ${filename}`);
  }
}
const configFound = assertConfigFound();

/** Every rule, message, and location where the markup is not valid, or none. */
export async function htmlProblems(markup: string): Promise<string[]> {
  await configFound;
  return messagesOf(await validator.validateString(markup, filename));
}

// The browser serializes a boolean attribute such as `hidden` as `hidden=""`, and keeps the
// whitespace that was around an element a script removed, so these two rules would report the
// serializer's style, not markup that Haystack wrote. Every other rule of the config still runs.
const SERIALIZED_BY_THE_BROWSER = {
  rules: { "attribute-empty-style": "off", "no-trailing-whitespace": "off" },
} as const;

/**
 * The same as `htmlProblems`, for a page as the browser holds it, serialized, such as
 * Playwright's `page.content()`.
 */
export async function browserHtmlProblems(markup: string): Promise<string[]> {
  await configFound;
  return messagesOf(await validator.validateString(markup, filename, SERIALIZED_BY_THE_BROWSER));
}

function messagesOf(report: Awaited<ReturnType<HtmlValidate["validateString"]>>): string[] {
  return report.results.flatMap((result) =>
    result.messages.map((m) => `${m.ruleId} at ${m.line}:${m.column}: ${m.message}`),
  );
}
