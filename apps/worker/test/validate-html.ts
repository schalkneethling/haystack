// Validates rendered markup with html-validate and the repository's .htmlvalidate.json (#3).
// The config is found by walking up from the filename, as the CLI does.
import { fileURLToPath } from "node:url";
import { FileSystemConfigLoader, HtmlValidate } from "html-validate";
import { expect } from "vite-plus/test";

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

/** Fails with every rule, message, and location when the markup is not valid. */
export async function expectValidHtml(markup: string): Promise<void> {
  await configFound;
  const report = await validator.validateString(markup, filename);
  const problems = report.results.flatMap((result) =>
    result.messages.map((m) => `${m.ruleId} at ${m.line}:${m.column}: ${m.message}`),
  );
  expect(problems).toEqual([]);
}
