// For the tests that build a regular expression from text, such as an address or a sentence.

/** `text` with every character that has a meaning in a regular expression escaped. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
