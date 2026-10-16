// What the popup does when the toolbar button is clicked. See "## Extension" and "Sensitive
// URLs" in plans/haystack-v1-implementation-plan.md. It reads the active tab, refuses what
// Haystack can't save, and otherwise opens the Worker's /save form in a new tab. It takes the
// browser API and the Worker's origin as parameters, so tests can pass fakes.
import {
  CAPTURE_CAPS,
  type CaptureField,
  type CapturePayload,
  detectSensitiveUrl,
  isHttpsUrl,
  SENSITIVE_URL_EXPLANATIONS,
  truncate,
  validateCapturePayload,
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

// The text fields of the payload and where each comes from in the page's metadata. Every cap
// is a field's own, so a new text field needs only a line here.
const TEXT_FIELDS = [
  ["title", "documentTitle"],
  ["description", "description"],
  ["og_title", "ogTitle"],
  ["og_description", "ogDescription"],
  ["og_site_name", "ogSiteName"],
] as const satisfies ReadonlyArray<readonly [CaptureField, keyof PageMetadata]>;

const METADATA_KEYS = ["canonicalUrl", ...TEXT_FIELDS.map(([, key]) => key)] as const;

type RawMetadata = Partial<Record<keyof PageMetadata, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The strings among what the page returned. The result comes from a page the user does not
// control, so a result that is not an object, and any value that is not a string, is ignored
// rather than trusted to have the shape readPageMetadata gives it.
function stringsIn(result: unknown): RawMetadata {
  if (!isRecord(result)) {
    return {};
  }
  const strings: RawMetadata = {};
  for (const key of METADATA_KEYS) {
    const value = result[key];
    if (typeof value === "string") {
      strings[key] = value;
    }
  }
  return strings;
}

// What the page says about itself. The tab's title stands in for the page's own when the page
// can't be scripted (browser pages and the extension stores refuse executeScript) or doesn't
// give one.
async function pageMetadata(api: PopupBrowser, tab: ActiveTab): Promise<RawMetadata> {
  const fromTab: RawMetadata = tab.title === undefined ? {} : { documentTitle: tab.title };
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

// The payload to validate: the page's address, and each captured field cut to its cap. Text is
// trimmed first so that the cap counts what the schema keeps. The canonical URL is serialized
// the way the page's own address is, and never cut, because a shortened URL can point
// somewhere else. An over-cap one is therefore left for validation to reject.
function candidatePayload(url: string, metadata: RawMetadata): Record<string, string> {
  const candidate: Record<string, string> = { url };
  if (metadata.canonicalUrl !== undefined) {
    candidate.canonical_url =
      URL.parse(metadata.canonicalUrl.trim())?.href ?? metadata.canonicalUrl;
  }
  for (const [field, key] of TEXT_FIELDS) {
    const text = metadata[key];
    if (text !== undefined) {
      candidate[field] = truncate(text.trim(), CAPTURE_CAPS[field]);
    }
  }
  return candidate;
}

/** The Worker's save form for a payload. `origin` is an origin alone, without a slash. */
function saveUrl(origin: string, payload: CapturePayload): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(payload)) {
    parameters.set(name, value);
  }
  return `${origin}/save?${parameters.toString()}`;
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
  const candidate = candidatePayload(url, await pageMetadata(api, tab));
  const validated = validateCapturePayload(candidate);
  const payload = validated.ok
    ? validated.payload
    : withoutInvalidFields(candidate, validated.invalidFields, urlOnly.payload);
  const target = saveUrl(origin, payload);
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
