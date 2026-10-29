// Validates rendered markup with html-validate and the repository's .htmlvalidate.json (#3), in
// the integration tests. html-problems.ts holds the validator.
import { expect } from "vite-plus/test";
import { htmlProblems } from "./html-problems.ts";

/** Fails with every rule, message, and location when the markup is not valid. */
export async function expectValidHtml(markup: string): Promise<void> {
  expect(await htmlProblems(markup)).toEqual([]);
}
