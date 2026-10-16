import { CAPTURE_CAPS, SENSITIVE_URL_EXPLANATIONS } from "@haystack/schemas";
import { describe, expect, it } from "vite-plus/test";
import {
  type ActiveTab,
  openSaveForm,
  POPUP_MESSAGES,
  type PopupBrowser,
} from "../src/open-save-form.ts";

const ORIGIN = "https://haystack.example";

interface FakeOptions {
  tab?: ActiveTab;
  /** What the page's document.title is, or an error when the page can't be scripted. */
  documentTitle?: string | Error;
  createFails?: boolean;
  queryFails?: boolean;
}

// The popup's view of the browser, recording the tabs it opens and the scripts it runs.
function fakeBrowser({
  tab,
  documentTitle = "Document title",
  createFails = false,
  queryFails = false,
}: FakeOptions) {
  const created: string[] = [];
  const scripted: number[] = [];
  const api: PopupBrowser = {
    tabs: {
      query: async () => {
        if (queryFails) {
          throw new Error("No current window");
        }
        return tab === undefined ? [] : [tab];
      },
      create: async ({ url }) => {
        if (createFails) {
          throw new Error("No window");
        }
        created.push(url);
      },
    },
    scripting: {
      executeScript: async ({ target }) => {
        scripted.push(target.tabId);
        if (documentTitle instanceof Error) {
          throw documentTitle;
        }
        return [{ result: documentTitle }];
      },
    },
  };
  return { api, created, scripted };
}

function tabAt(url: string, title = "Tab title"): ActiveTab {
  return { id: 7, url, title };
}

function saveParameters(saveUrl: string): Record<string, string> {
  return Object.fromEntries(new URL(saveUrl).searchParams);
}

describe("openSaveForm", () => {
  it("opens the Worker's save form with the page's address and document title", async () => {
    const fake = fakeBrowser({ tab: tabAt("https://example.com/article") });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome).toEqual({ opened: true, saveUrl: fake.created[0] });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.startsWith(`${ORIGIN}/save?`)).toBe(true);
    expect(saveParameters(fake.created[0] ?? "")).toEqual({
      url: "https://example.com/article",
      title: "Document title",
    });
  });

  it("sends the address as the URL parser serializes it", async () => {
    const fake = fakeBrowser({ tab: tabAt("https://EXAMPLE.com/café menu") });

    await openSaveForm(fake.api, ORIGIN);

    expect(saveParameters(fake.created[0] ?? "").url).toBe("https://example.com/caf%C3%A9%20menu");
  });

  it("refuses a sensitive URL with the shared reason, before scripting the page", async () => {
    const fake = fakeBrowser({ tab: tabAt("https://example.com/callback#access_token=secret") });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome).toEqual({
      opened: false,
      heading: "This page can't be saved",
      message: SENSITIVE_URL_EXPLANATIONS["credential-parameter"],
    });
    expect(fake.created).toEqual([]);
    expect(fake.scripted).toEqual([]);
  });

  it("checks the URL as the tab reports it, so a sensitive http URL gets the sensitive reason", async () => {
    const fake = fakeBrowser({ tab: tabAt("http://user:pass@example.com/") });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome).toMatchObject({ message: SENSITIVE_URL_EXPLANATIONS["embedded-credentials"] });
    expect(fake.created).toEqual([]);
  });

  for (const url of [
    "http://example.com/article",
    "chrome://newtab/",
    "file:///Users/me/a.html",
    "about:blank",
  ]) {
    it(`refuses a page that isn't https (${url})`, async () => {
      const fake = fakeBrowser({ tab: tabAt(url) });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome).toMatchObject({ opened: false, message: POPUP_MESSAGES.notHttps });
      expect(fake.created).toEqual([]);
    });
  }

  it("refuses an address whose serialized form is over the cap, without truncating it", async () => {
    // 400 characters before serializing, but each one becomes 6 once percent-encoded.
    const url = `https://example.com/${"é".repeat(400)}`;
    expect(url.length).toBeLessThanOrEqual(CAPTURE_CAPS.url);
    const fake = fakeBrowser({ tab: tabAt(url) });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome).toMatchObject({ opened: false, message: POPUP_MESSAGES.tooLong });
    expect(fake.created).toEqual([]);
  });

  it("falls back to the tab's title when the page can't be scripted", async () => {
    const fake = fakeBrowser({
      tab: tabAt("https://chromewebstore.google.com/detail/x", "Store listing"),
      documentTitle: new Error("The extensions gallery cannot be scripted."),
    });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome.opened).toBe(true);
    expect(saveParameters(fake.created[0] ?? "")).toEqual({
      url: "https://chromewebstore.google.com/detail/x",
      title: "Store listing",
    });
  });

  it("leaves out a title that fails validation, so the form falls back to the address", async () => {
    const fake = fakeBrowser({
      tab: tabAt("https://example.com/"),
      documentTitle: "t".repeat(CAPTURE_CAPS.title + 1),
    });

    await openSaveForm(fake.api, ORIGIN);

    expect(saveParameters(fake.created[0] ?? "")).toEqual({ url: "https://example.com/" });
  });

  it("says it can't read the tab when there is no address", async () => {
    for (const tab of [undefined, { id: 1, title: "No URL" }, { id: 1, url: "", title: "" }]) {
      const fake = fakeBrowser(tab === undefined ? {} : { tab });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome).toMatchObject({ opened: false, message: POPUP_MESSAGES.noAddress });
      expect(fake.created).toEqual([]);
    }
  });

  // Without this the popup would stay on its loading message, and announce nothing.
  for (const [name, options] of [
    ["the save form's tab can't be opened", { createFails: true }],
    ["the active tab can't be read", { queryFails: true }],
  ] as const) {
    it(`says the form didn't open when ${name}`, async () => {
      const fake = fakeBrowser({ tab: tabAt("https://example.com/"), ...options });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome).toEqual({
        opened: false,
        heading: "The save form didn't open",
        message: POPUP_MESSAGES.notOpened,
      });
      expect(fake.created).toEqual([]);
    });
  }
});
