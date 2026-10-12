// Validates rendered markup with html-validate and the repository's .htmlvalidate.json (#3).
// The config is found by walking up from the filename, as the CLI does.
import { fileURLToPath } from "node:url";
import { FileSystemConfigLoader, HtmlValidate } from "html-validate";
import { expect } from "vite-plus/test";

const validator = new HtmlValidate(new FileSystemConfigLoader());
const filename = fileURLToPath(new URL("./rendered.html", import.meta.url));

/** Fails with every rule, message, and location when the markup is not valid. */
export async function expectValidHtml(markup: string): Promise<void> {
  const report = await validator.validateString(markup, filename);
  const problems = report.results.flatMap((result) =>
    result.messages.map((m) => `${m.ruleId} at ${m.line}:${m.column}: ${m.message}`),
  );
  expect(problems).toEqual([]);
}
