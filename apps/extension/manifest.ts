// The extension's manifest, written into each build by build.ts. See "## Extension" in
// plans/haystack-v1-implementation-plan.md. The popup does everything, so there is no
// background script, and `activeTab` plus `scripting` are the only permissions: no host
// permissions and no content scripts.
// The keys are checked against @types/chrome's manifest type. The reference loads those types for
// this file wherever it is compiled, because the build runs in Node, not in the extension.
/// <reference types="chrome" />

// The data types Firefox lets an extension declare it collects and sends outside the browser
// (https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings).
// `none` is left out because it can't be combined with any other, and Haystack collects data.
type DataCollectionPermission =
  | "authenticationInfo"
  | "bookmarksInfo"
  | "browsingActivity"
  | "financialAndPaymentInfo"
  | "healthInfo"
  | "locationInfo"
  | "personalCommunications"
  | "personallyIdentifyingInfo"
  | "searchTerms"
  | "websiteActivity"
  | "websiteContent";

// @types/chrome has no `browser_specific_settings`, because Chrome ignores it, so Firefox's keys
// are typed here. Firefox has no `minimum_chrome_version`, so that key is not part of its type.
type FirefoxManifest = Omit<chrome.runtime.ManifestV3, "minimum_chrome_version"> & {
  browser_specific_settings: {
    gecko: {
      id: string;
      strict_min_version: string;
      data_collection_permissions: {
        required: [DataCollectionPermission, ...DataCollectionPermission[]];
      };
    };
    gecko_android: { strict_min_version: string };
  };
};

export type Manifest = chrome.runtime.ManifestV3 | FirefoxManifest;

/** The browsers the extension is built for. */
export const BROWSERS = ["chrome", "firefox"] as const;
export type Browser = (typeof BROWSERS)[number];

// The first Chrome release with every extension API under the `browser` namespace, with
// promises (https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace).
// The popup calls `browser` directly, with no polyfill.
const MINIMUM_CHROME_VERSION = "148";

// The add-on ID is permanent once the add-on is signed on addons.mozilla.org, which is why it
// doesn't carry the product's name: the name can still change (Q6). Firefox requires an ID to
// sign a Manifest V3 add-on, and accepts an ID that looks like an email address
// (https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings).
const FIREFOX_ADDON_ID = "bookmarks@schalkneethling.com";

// Firefox 140 is the first desktop release with built-in data collection consent
// (https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/), which
// addons.mozilla.org requires of new extensions. It is newer than everything else the extension
// uses: Manifest V3 (Firefox 109, https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/),
// `scripting.executeScript` (Firefox 101 in Manifest V3,
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript),
// and the promise-based `browser` namespace, which Firefox has always had. A lower minimum would
// let the add-on install on a Firefox that cannot show the consent the declaration below needs.
const FIREFOX_MINIMUM_VERSION = "140.0";

// Firefox for Android added built-in consent two releases later, in 142. Without its own minimum,
// the Android one falls back to the desktop minimum, and web-ext lint warns that Android 140
// cannot show the consent. Haystack doesn't target Android, so this only keeps the add-on from
// installing on a version that would let it send data without consent.
const FIREFOX_ANDROID_MINIMUM_VERSION = "142.0";

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
  } satisfies chrome.runtime.ManifestV3;
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
    case "firefox":
      return {
        ...sharedManifest(version),
        browser_specific_settings: {
          gecko: {
            id: FIREFOX_ADDON_ID,
            strict_min_version: FIREFOX_MINIMUM_VERSION,
            // The popup sends the page's address (browsing activity) and its title and
            // description (website content) to Haystack's own server.
            data_collection_permissions: { required: ["browsingActivity", "websiteContent"] },
          },
          gecko_android: { strict_min_version: FIREFOX_ANDROID_MINIMUM_VERSION },
        },
      };
  }
}
