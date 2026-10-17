// Which http: URLs Haystack accepts: only those on this machine, for local development and
// tests. The Worker applies it to the Google endpoints it is configured with, and the extension's
// build to the Worker's origin, so the two agree on what counts as local.

/** Host names that always mean this machine, as `URL.hostname` writes them. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL uses https:, or http: on a loopback host. */
export function isHttpsOrLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}
