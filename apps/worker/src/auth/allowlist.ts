// ALLOWED_EMAILS is a comma-separated list. Matching ignores ASCII case and surrounding
// whitespace. Only A-Z is folded: toLowerCase() would also map characters such as U+212A
// KELVIN SIGN to "k", so a different address could match an allowed one.

function normalize(email: string): string {
  return email.trim().replace(/[A-Z]/g, (char) => char.toLowerCase());
}

export function parseAllowedEmails(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map(normalize)
      .filter((email) => email !== ""),
  );
}

export function isEmailAllowed(allowed: ReadonlySet<string>, email: string): boolean {
  return allowed.has(normalize(email));
}
