// What the popup does when the toolbar button is clicked. See "## Extension" and "Sensitive
// URLs" in plans/haystack-v1-implementation-plan.md. It reads the active tab, refuses what
// Haystack can't save, and otherwise opens the Worker's /save form in a new tab. It takes the
// browser API and the Worker's origin as parameters, so tests can pass fakes.
import {
  CAPTURE_CAPS,
  type CapturePayload,
  detectSensitiveUrl,
  isHttpsUrl,
  SENSITIVE_URL_EXPLANATIONS,
  validateCapturePayload,
} from "@haystack/schemas";

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
      func: () => string;
    }): Promise<Array<{ result?: string | undefined }>>;
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

// Runs in the page, through executeScript, so it must not use anything from this module.
function readDocumentTitle(): string {
  return document.title;
}

// The page's own title, or the tab's title when the page can't be scripted (browser pages and
// the extension stores refuse executeScript).
async function pageTitle(api: PopupBrowser, tab: ActiveTab): Promise<string | undefined> {
  if (tab.id === undefined) {
    return tab.title;
  }
  try {
    const [injection] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: readDocumentTitle,
    });
    return typeof injection?.result === "string" ? injection.result : tab.title;
  } catch {
    return tab.title;
  }
}

/** The Worker's save form for a payload. `origin` is an origin alone, without a slash. */
function saveUrl(origin: string, payload: CapturePayload): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(payload)) {
    parameters.set(name, value);
  }
  return `${origin}/save?${parameters.toString()}`;
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
  // A title that fails validation is left out rather than refusing the page, because the form
  // falls back to the address. Truncating titles to the cap comes with the metadata (#72).
  const title = await pageTitle(api, tab);
  const withTitle = title === undefined ? urlOnly : validateCapturePayload({ url, title });
  const payload = withTitle.ok ? withTitle.payload : urlOnly.payload;
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
