/**
 * What can be logged about an error: its code when it has one, a fixed string such as
 * OAUTH_JWT_CLAIM_COMPARISON_FAILED or JEV_BASE_URL_INVALID, and otherwise its name. The message
 * and the cause are never logged, because they can hold a callback's parameters and claims, a
 * bookmark's URL or a value from the configuration.
 */
export function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}
