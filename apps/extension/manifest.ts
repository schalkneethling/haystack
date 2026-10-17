// The extension's manifest, written into each build by build.ts. See "## Extension" in
// plans/haystack-v1-implementation-plan.md. The popup does everything, so there is no
// background script, and `activeTab` plus `scripting` are the only permissions: no host
// permissions and no content scripts.
// The keys are checked against @types/chrome's manifest type. The reference loads those types for
// this file wherever it is compiled, because the build runs in Node, not in the extension.
/// <reference types="chrome" />

export type Manifest = chrome.runtime.ManifestV3;

/** The browsers the extension is built for. Firefox follows in #71. */
export type Browser = "chrome";

// The first Chrome release with every extension API under the `browser` namespace, with
// promises (https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace).
// The popup calls `browser` directly, with no polyfill.
const MINIMUM_CHROME_VERSION = "148";

// Chrome accepts one to four dot-separated integers from 0 to 65535, without leading zeros
// and not all zero (https://developer.chrome.com/docs/extensions/reference/manifest/version).
const MANIFEST_VERSION_FORMAT = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

function isManifestVersion(version: string): boolean {
  return (
    MANIFEST_VERSION_FORMAT.test(version) &&
    version.split(".").every((part) => Number(part) <= 65535) &&
    version.split(".").some((part) => part !== "0")
  );
}

// The keys every browser's build shares. A browser's own keys are added in manifestFor.
function sharedManifest(version: string) {
  return {
    manifest_version: 3,
    name: "Haystack",
    version,
    description: "Save the current page to Haystack.",
    action: { default_title: "Save to Haystack", default_popup: "index.html" },
    permissions: ["activeTab", "scripting"],
  } satisfies Manifest;
}

/**
 * The manifest for one browser. The version comes from the extension's package.json, and must
 * be a version the browser accepts.
 */
export function manifestFor(browser: Browser, version: string): Manifest {
  if (!isManifestVersion(version)) {
    throw new Error(
      `The extension's version "${version}" must be one to four dot-separated numbers, not all zero, for example 0.1.0.`,
    );
  }
  switch (browser) {
    case "chrome":
      return { ...sharedManifest(version), minimum_chrome_version: MINIMUM_CHROME_VERSION };
  }
}
