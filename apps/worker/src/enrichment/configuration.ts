// The configuration errors the enrichment clients share: Jev's (jev-client.ts), GitHub's
// (github-client.ts) and the LLM adapters' (anthropic-messages.ts and the two adapters). See
// "Enrichment sweep" in plans/haystack-v1-implementation-plan.md. Each is thrown before anything
// is sent, with a code the sweep (#127) can match on and log, because a configuration error is
// the run's problem, not the bookmark's.
import { isHttpsOrLoopbackUrl } from "@haystack/schemas";

/** An error in the configuration, thrown before anything is sent. The code is safe to log. */
export function configurationError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * The base URL in the variable `name`, parsed. Throws `<name>_INVALID` when the value is empty,
 * missing or doesn't parse, or when it is neither https nor http on a loopback host, where the
 * integration tests' plain-http server runs (Q10 in the plan). The message names the variable but
 * not its value, which could hold a credential someone pasted by mistake (#155). A request URL is
 * an absolute path resolved against the result, so it has the same scheme and host.
 */
export function checkedBaseUrl(name: string, value: string): URL {
  // The value can be missing, although `Env` says `string`, when a test's configuration or local
  // development leaves it out. `new URL` would throw a bare TypeError for it, with no code.
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (url === null) {
    throw configurationError(`${name} is empty or isn't a URL`, `${name}_INVALID`);
  }
  if (!isHttpsOrLoopbackUrl(url)) {
    throw configurationError(
      `${name} must be an https URL, or http on a loopback host`,
      `${name}_INVALID`,
    );
  }
  return url;
}
