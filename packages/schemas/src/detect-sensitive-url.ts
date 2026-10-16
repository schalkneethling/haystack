// Deterministic refusal of URLs that are secrets in themselves. See "Sensitive URLs" in
// plans/haystack-v1-implementation-plan.md. A match is a hard refusal with no override, so the
// lists stay narrow. A parameter counts only when it has a non-empty value, so an anchor such
// as `#access_token` on a documentation page is not refused.

export type SensitiveUrlReason =
  | "embedded-credentials"
  | "signed-storage-url"
  | "credential-parameter";

// One explanation per reason, shared by the extension's popup and the Worker's refusal page so
// both say the same thing. None of them quotes the URL, because the URL may be the secret.
export const SENSITIVE_URL_EXPLANATIONS: Readonly<Record<SensitiveUrlReason, string>> =
  Object.freeze({
    "embedded-credentials":
      "This link contains a user name or password, so anyone who has it could sign in with them.",
    "signed-storage-url":
      "This link contains a signed access key, so it could let anyone who has it download the file.",
    "credential-parameter":
      "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
  });

// Pre-signed storage URLs (S3 and Google Cloud Storage), in the query string only. Names are
// compared in lowercase. An addition needs a test case and a similar-legitimate-URL test.
export const SIGNED_STORAGE_PARAMETERS: readonly string[] = Object.freeze([
  "x-amz-signature",
  "x-amz-credential",
  "x-goog-signature",
]);

// Azure shared access signatures carry both `sig` and `se` in the query string. `sig` alone is
// too generic. A change needs a test case and a similar-legitimate-URL test.
export const AZURE_SAS_PARAMETERS: readonly ["sig", "se"] = Object.freeze(["sig", "se"] as const);

// Parameters that carry credentials, in the query string or the fragment. An addition needs a
// test case and a similar-legitimate-URL test.
export const CREDENTIAL_PARAMETERS: readonly string[] = Object.freeze([
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "password",
  "client_secret",
]);

// Lowercased names of parameters with a non-empty value.
function namesWithValues(source: string): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of new URLSearchParams(source)) {
    if (value !== "") {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

// The fragment is read as `key=value` pairs (OAuth implicit flow: `#access_token=…`). For hash
// routes such as `#/callback?access_token=…`, the part after the first `?` is read too.
function fragmentNames(url: URL): Set<string> {
  const fragment = url.hash.slice(1);
  const names = namesWithValues(fragment);
  const queryInFragment = fragment.indexOf("?");
  if (queryInFragment !== -1) {
    for (const name of namesWithValues(fragment.slice(queryInFragment + 1))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Returns why the URL must not be saved, or undefined. Pass the URL as submitted, not its
 * normalized form, which has no fragment or credentials left to check. The reason never
 * contains any part of the URL, so callers can show a message without echoing the URL back.
 */
export function detectSensitiveUrl(url: URL): SensitiveUrlReason | undefined {
  if (url.username !== "" || url.password !== "") {
    return "embedded-credentials";
  }
  const queryNames = namesWithValues(url.search);
  const inQuery = (name: string) => queryNames.has(name);
  if (SIGNED_STORAGE_PARAMETERS.some(inQuery) || AZURE_SAS_PARAMETERS.every(inQuery)) {
    return "signed-storage-url";
  }
  const names = new Set([...queryNames, ...fragmentNames(url)]);
  if (CREDENTIAL_PARAMETERS.some((name) => names.has(name))) {
    return "credential-parameter";
  }
  return undefined;
}
