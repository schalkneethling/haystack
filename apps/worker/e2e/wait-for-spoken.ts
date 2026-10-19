// Waiting for VoiceOver to say a short phrase, for the *.voiceover.ts tests: the delete dialog's
// status message, and the address form's pending state (#105).
import type { VoiceOverPlaywright } from "@guidepup/playwright";

/**
 * Waits until VoiceOver speaks a phrase that matches `pattern`, and returns every new phrase
 * heard on the way.
 *
 * Guidepup records one joined entry per command. With `capture: true` it keeps looking after a
 * new phrase, waiting about as long as the phrase takes to say between looks, so a long hint
 * such as "You are currently on a button, ..." can hide a short phrase that follows it. With
 * `capture: "initial"` it looks once and stops. This presses Shift with `"initial"` repeatedly,
 * so that Guidepup looks at VoiceOver's last phrase again after each press, and stops at the
 * first match. Each press and look takes a fraction of a second on the CI runner. Shift on its
 * own does nothing in VoiceOver or on the page, so the presses only give Guidepup a reason to
 * look.
 */
export async function waitForSpoken(
  voiceOver: VoiceOverPlaywright,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string[]> {
  const heard: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await voiceOver.press("Shift", { capture: "initial" });
    // When the phrase is the same as the last one logged, Guidepup logs an empty entry. The next
    // look then logs the same phrase again, because it compares with that empty entry, so the
    // comparison with `heard` below skips repeats.
    const phrase = (await voiceOver.spokenPhraseLog()).at(-1) ?? "";
    if (phrase !== "" && phrase !== heard.at(-1)) {
      heard.push(phrase);
      if (pattern.test(phrase)) {
        return heard;
      }
    }
  }
  throw new Error(`VoiceOver did not say ${String(pattern)}. It said: ${JSON.stringify(heard)}`);
}
