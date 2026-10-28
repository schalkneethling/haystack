// Checking the order of what VoiceOver said, for the *.voiceover.ts tests.
import { expect } from "@playwright/test";

/**
 * Checks that each part appears in the spoken phrases, in this order, each in a later phrase than
 * the one before. With the default capture, each move of the VoiceOver cursor adds one phrase to
 * the log, so the ordered checks run after moves made with the default capture. With
 * `capture: true`, Guidepup joins everything spoken until silence into one entry, and the parts
 * would no longer be in separate phrases.
 */
export function expectInOrder(
  spoken: readonly string[],
  parts: readonly (string | RegExp)[],
): void {
  let from = 0;
  for (const part of parts) {
    const found = spoken.findIndex(
      (phrase, index) =>
        index >= from && (typeof part === "string" ? phrase.includes(part) : part.test(phrase)),
    );
    expect(
      found,
      `"${String(part)}" from phrase ${from} in ${JSON.stringify(spoken)}`,
    ).toBeGreaterThanOrEqual(0);
    from = found + 1;
  }
}
