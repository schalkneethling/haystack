// Deterministic refusal of URLs that are secrets in themselves. See "Sensitive URLs" in
// plans/haystack-v1-implementation-plan.md. A match is a hard refusal with no override, so the
// lists stay narrow. Every addition needs a test case and a test proving that a similar
// legitimate URL is still accepted.

export type SensitiveUrlReason =
  | "embedded-credentials"
  | "signed-storage-url"
  | "credential-parameter";

// Pre-signed storage URLs (S3 and Google Cloud Storage). Names are compared in lowercase.
export const SIGNED_STORAGE_PARAMETERS: ReadonlySet<string> = new Set([
  "x-amz-signature",
  "x-amz-credential",
  "x-goog-signature",
]);

// Azure shared access signatures carry both `sig` and `se`. `sig` alone is too generic.
export const AZURE_SAS_PARAMETERS: readonly string[] = ["sig", "se"];

// Parameters that carry credentials, in the query string or the fragment.
export const CREDENTIAL_PARAMETERS: ReadonlySet<string> = new Set([
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "client_secret",
]);

// Lowercased parameter names from the query string and the fragment. A fragment is read as
// `key=value` pairs (OAuth implicit flow: `#access_token=…`), and for hash routes such as
// `#/callback?access_token=…`, the part after the first `?` is read too.
function parameterNames(url: URL): Set<string> {
  const fragment = url.hash.slice(1);
  const sources = [url.search, fragment];
  const queryInFragment = fragment.indexOf("?");
  if (queryInFragment !== -1) {
    sources.push(fragment.slice(queryInFragment + 1));
  }
  const names = new Set<string>();
  for (const source of sources) {
    for (const name of new URLSearchParams(source).keys()) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/**
 * Returns why the URL must not be saved, or undefined. The reason never contains any part of
 * the URL, so callers can show a message without echoing the URL back.
 */
export function detectSensitiveUrl(url: URL): SensitiveUrlReason | undefined {
  if (url.username !== "" || url.password !== "") {
    return "embedded-credentials";
  }
  const names = parameterNames(url);
  const has = (name: string) => names.has(name);
  if ([...SIGNED_STORAGE_PARAMETERS].some(has) || AZURE_SAS_PARAMETERS.every(has)) {
    return "signed-storage-url";
  }
  if ([...CREDENTIAL_PARAMETERS].some(has)) {
    return "credential-parameter";
  }
  return undefined;
}
