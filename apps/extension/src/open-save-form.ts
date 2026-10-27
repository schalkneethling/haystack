// What the popup does when the toolbar button is clicked. See "## Extension" and "Sensitive
// URLs" in plans/haystack-v1-implementation-plan.md. It reads the active tab, refuses what
// Haystack can't save, and otherwise opens the Worker's /save form in a new tab. It takes the
// browser API and the Worker's origin as parameters, so tests can pass fakes.
import {
  CAPTURE_CAPS,
  type CaptureField,
  type CapturePayload,
  capturedFieldsFromPage,
  detectSensitiveUrl,
  isHttpsUrl,
  PAGE_METADATA_KEYS,
  type RawPageMetadata,
  saveUrlWithinBudget,
  SENSITIVE_URL_EXPLANATIONS,
  validateCapturePayload,
  withoutSensitiveCanonicalUrl,
} from "@haystack/schemas";
import { type PageMetadata, readPageMetadata } from "./read-page-metadata.ts";

/** The tab fields the popup reads. `activeTab` grants the URL and title of the active tab. */
export interface ActiveTab {
  id?: number | undefined;
  url?: string | undefined;
  title?: string | undefined;
}

/** The part of the `browser` namespace the popup uses. */
export interface PopupBrowser {
  tabs: {
    query(queryInfo: { active: true; currentWindow: true }): Promise<ActiveTab[]>;
    create(createProperties: { url: string }): Promise<unknown>;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      func: () => PageMetadata;
    }): Promise<Array<{ result?: unknown }>>;
  };
}

export type PopupOutcome =
  | { opened: true; saveUrl: string }
  | { opened: false; heading: string; message: string };

const CANT_SAVE = "This page can't be saved";

export const POPUP_MESSAGES = {
  noAddress: "Haystack can't read this tab's address.",
  notHttps: "Haystack saves only secure pages, whose address starts with https://.",
  tooLong: "This page's address is too long to save.",
  notOpened: "Haystack couldn't open the save form. Try again.",
} as const;

function refused(message: string): PopupOutcome {
  return { opened: false, heading: CANT_SAVE, message };
}

// The payload is built from the values readPageMetadata returns, by the same names.
PAGE_METADATA_KEYS satisfies ReadonlyArray<keyof PageMetadata>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The strings among what the page returned. The result comes from a page the user does not
// control, so a result that is not an object, and any value that is not a string, is ignored
// rather than trusted to have the shape readPageMetadata gives it.
function stringsIn(result: unknown): RawPageMetadata {
  if (!isRecord(result)) {
    return {};
  }
  const strings: RawPageMetadata = {};
  for (const key of PAGE_METADATA_KEYS) {
    const value = result[key];
    if (typeof value === "string") {
      strings[key] = value;
    }
  }
  return strings;
}

// What the page says about itself. The tab's title stands in for the page's own only when the
// page can't be scripted (browser pages and the extension stores refuse executeScript) or the
// result has no string document title. A page without a title gives "", which wins: for an
// untitled page Chrome's tab title is the host and path, which is worse than the form's
// fallback, the full address.
async function pageMetadata(api: PopupBrowser, tab: ActiveTab): Promise<RawPageMetadata> {
  const fromTab: RawPageMetadata = tab.title === undefined ? {} : { documentTitle: tab.title };
  if (tab.id === undefined) {
    return fromTab;
  }
  try {
    const [injection] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageMetadata,
    });
    return { ...fromTab, ...stringsIn(injection?.result) };
  } catch {
    return fromTab;
  }
}

// The payload without the fields that failed validation. The address passed on its own, so a
// second failure is not expected, but if it happens the address alone is sent.
function withoutInvalidFields(
  candidate: Record<string, string>,
  invalidFields: readonly CaptureField[],
  urlOnly: CapturePayload,
): CapturePayload {
  const kept = Object.entries(candidate).filter(
    ([name]) => !invalidFields.includes(name as CaptureField),
  );
  const revalidated = validateCapturePayload(Object.fromEntries(kept));
  return revalidated.ok ? revalidated.payload : urlOnly;
}

const NOT_OPENED: PopupOutcome = {
  opened: false,
  heading: "The save form didn't open",
  message: POPUP_MESSAGES.notOpened,
};

// The steps of openSaveForm. Any of the browser calls can reject, and openSaveForm turns that
// into a message.
async function decideAndOpen(api: PopupBrowser, origin: string): Promise<PopupOutcome> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const rawUrl = tab?.url === undefined ? null : URL.parse(tab.url);
  if (tab === undefined || rawUrl === null) {
    return refused(POPUP_MESSAGES.noAddress);
  }
  const reason = detectSensitiveUrl(rawUrl);
  if (reason !== undefined) {
    return refused(SENSITIVE_URL_EXPLANATIONS[reason]);
  }
  // The cap applies to the serialized form, which can be much longer than the original, and
  // the save URL carries that form.
  const url = rawUrl.href;
  const urlOnly = validateCapturePayload({ url });
  if (!urlOnly.ok) {
    const tooLong = isHttpsUrl(url) && url.length > CAPTURE_CAPS.url;
    return refused(tooLong ? POPUP_MESSAGES.tooLong : POPUP_MESSAGES.notHttps);
  }
  // A field that fails validation is left out rather than refusing the page: the form falls
  // back to the other fields, and in the end to the address.
  const candidate = capturedFieldsFromPage(url, await pageMetadata(api, tab));
  const validated = validateCapturePayload(candidate);
  const payload = validated.ok
    ? validated.payload
    : withoutInvalidFields(candidate, validated.invalidFields, urlOnly.payload);
  // A canonical URL that carries a secret is left out the same way, so it never leaves the
  // browser. The page itself has already passed the check above. In its place the payload carries
  // the flag `sensitive_canonical_dropped=1`, which the budget never drops (#131). The budget then
  // runs on that final payload, so it never counts a field that is not sent.
  const target = saveUrlWithinBudget(origin, withoutSensitiveCanonicalUrl(payload));
  await api.tabs.create({ url: target });
  return { opened: true, saveUrl: target };
}

/**
 * Opens the save form for the active tab, or says why not. It never rejects, so the popup
 * always leaves its loading state. The sensitive URL check runs on the tab's URL as the browser
 * reports it, before anything else, so a flagged URL never leaves the browser and the Worker
 * never sees a cleaner URL than the extension did.
 */
export async function openSaveForm(api: PopupBrowser, origin: string): Promise<PopupOutcome> {
  try {
    return await decideAndOpen(api, origin);
  } catch {
    return NOT_OPENED;
  }
}
