// ALLOWED_EMAILS is a comma-separated list. Matching ignores case and surrounding whitespace.

export function parseAllowedEmails(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
}

export function isEmailAllowed(allowed: ReadonlySet<string>, email: string): boolean {
  return allowed.has(email.trim().toLowerCase());
}
