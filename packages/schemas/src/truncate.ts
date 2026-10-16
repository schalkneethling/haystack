// Cutting text to a cap. The extension truncates the captured fields with it before validating,
// and the save form cuts the URL down when it is the title's fallback. See "Captured payload from
// the extension" in plans/haystack-v1-implementation-plan.md.

/**
 * Cuts a string to at most `maxLength` UTF-16 code units, the unit the caps count, without
 * splitting a surrogate pair: when the cut would fall between the two halves of a pair, the
 * whole pair is dropped, so the result is one code unit shorter than the cap. A half that is
 * already alone in the input is not repaired, because validation rejects it.
 */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const end = /[\ud800-\udbff]/.test(value.charAt(maxLength - 1)) ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}
