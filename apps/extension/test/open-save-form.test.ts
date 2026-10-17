import { CAPTURE_CAPS, SENSITIVE_URL_EXPLANATIONS } from "@haystack/schemas";
import { describe, expect, it } from "vite-plus/test";
import {
  type ActiveTab,
  openSaveForm,
  POPUP_MESSAGES,
  type PopupBrowser,
} from "../src/open-save-form.ts";
import type { PageMetadata } from "../src/read-page-metadata.ts";

const ORIGIN = "https://haystack.example";

// What readPageMetadata returns for a page with none of the tags, with the given values on top.
function metadata(values: Partial<PageMetadata> = {}): PageMetadata {
  return {
    canonicalUrl: null,
    description: null,
    documentTitle: "",
    ogTitle: null,
    ogDescription: null,
    ogSiteName: null,
    ...values,
  };
}

interface FakeOptions {
  tab?: ActiveTab;
  /**
   * What the injected script returns, or an error when the page can't be scripted. Typed
   * loosely, because a page's answer is untrusted.
   */
  injected?: unknown;
  createFails?: boolean;
  queryFails?: boolean;
}

// The popup's view of the browser, recording the tabs it opens and the scripts it runs.
function fakeBrowser({
  tab,
  injected = metadata({ documentTitle: "Document title" }),
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
        if (injected instanceof Error) {
          throw injected;
        }
        return [{ result: injected }];
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

  for (const url of ["http://example.com/article", "chrome://newtab/", "file:///Users/me/a.html"]) {
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
      injected: new Error("The extensions gallery cannot be scripted."),
    });

    const outcome = await openSaveForm(fake.api, ORIGIN);

    expect(outcome.opened).toBe(true);
    expect(saveParameters(fake.created[0] ?? "")).toEqual({
      url: "https://chromewebstore.google.com/detail/x",
      title: "Store listing",
    });
  });

  it("puts every captured field into the save URL, under the names /save reads", async () => {
    const fake = fakeBrowser({
      tab: tabAt("https://example.com/article"),
      injected: metadata({
        canonicalUrl: "https://example.com/canonical",
        description: "The meta description.",
        documentTitle: "Document title",
        ogTitle: "Open Graph title",
        ogDescription: "Open Graph description.",
        ogSiteName: "Example",
      }),
    });

    await openSaveForm(fake.api, ORIGIN);

    expect(saveParameters(fake.created[0] ?? "")).toEqual({
      url: "https://example.com/article",
      canonical_url: "https://example.com/canonical",
      title: "Document title",
      description: "The meta description.",
      og_title: "Open Graph title",
      og_description: "Open Graph description.",
      og_site_name: "Example",
    });
  });

  it("leaves out the fields a page doesn't have", async () => {
    const fake = fakeBrowser({
      tab: tabAt("https://example.com/"),
      injected: metadata({ ogTitle: "   ", description: "" }),
    });

    await openSaveForm(fake.api, ORIGIN);

    expect(saveParameters(fake.created[0] ?? "")).toEqual({ url: "https://example.com/" });
  });

  describe("a text field over its cap", () => {
    const fields = [
      ["title", "documentTitle"],
      ["description", "description"],
      ["og_title", "ogTitle"],
      ["og_description", "ogDescription"],
      ["og_site_name", "ogSiteName"],
    ] as const;

    for (const [field, key] of fields) {
      it(`is cut to the cap for ${field}, so the page is still saved with it`, async () => {
        const cap = CAPTURE_CAPS[field];
        const fake = fakeBrowser({
          tab: tabAt("https://example.com/"),
          injected: metadata({ [key]: "x".repeat(cap + 50) }),
        });

        const outcome = await openSaveForm(fake.api, ORIGIN);

        expect(outcome.opened).toBe(true);
        expect(saveParameters(fake.created[0] ?? "")[field]).toBe("x".repeat(cap));
      });
    }

    it("is cut without splitting a surrogate pair", async () => {
      const grin = "😀";
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ ogTitle: `${"a".repeat(CAPTURE_CAPS.og_title - 1)}${grin}` }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "").og_title).toBe(
        "a".repeat(CAPTURE_CAPS.og_title - 1),
      );
    });

    it("is cut after trimming, so leading whitespace doesn't use up the cap", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ documentTitle: `   ${"t".repeat(CAPTURE_CAPS.title)}` }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "").title).toBe("t".repeat(CAPTURE_CAPS.title));
    });

    it("is cut for the tab's title too, when the page can't be scripted", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/", "t".repeat(CAPTURE_CAPS.title + 1)),
        injected: new Error("The extensions gallery cannot be scripted."),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "").title).toBe("t".repeat(CAPTURE_CAPS.title));
    });
  });

  describe("the canonical URL", () => {
    it("is sent as the URL parser serializes it", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ canonicalUrl: "https://EXAMPLE.com/café" }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "").canonical_url).toBe(
        "https://example.com/caf%C3%A9",
      );
    });

    it("is dropped, not truncated, when its serialized form is over the cap", async () => {
      // 400 characters before serializing, but each one becomes 6 once percent-encoded.
      const canonical = `https://example.com/${"é".repeat(400)}`;
      expect(canonical.length).toBeLessThanOrEqual(CAPTURE_CAPS.canonical_url);
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ canonicalUrl: canonical, ogTitle: "Kept" }),
      });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome.opened).toBe(true);
      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/",
        og_title: "Kept",
      });
    });

    it.each([
      ["not a URL", "not a url"],
      ["relative", "/article"],
      ["a script", "javascript:alert(1)"],
      ["a file", "file:///etc/passwd"],
    ])("is dropped when it is %s", async (_, canonicalUrl) => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ canonicalUrl }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "")).toEqual({ url: "https://example.com/" });
    });

    it("may be http, because it is only evidence and is never linked", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ canonicalUrl: "http://example.com/article" }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "").canonical_url).toBe(
        "http://example.com/article",
      );
    });
  });

  describe("an executeScript result that isn't what readPageMetadata returns", () => {
    // The function's types say what it returns, but whatever comes back is data from an
    // untrusted page, so the popup checks the shape instead of trusting the types.
    it.each([
      ["a string", "Page title"],
      ["a number", 42],
      ["null", null],
      ["an array", ["Page title"]],
      ["an object without the fields", {}],
    ])("is ignored when it is %s, and the tab's title is used", async (_, injected) => {
      const fake = fakeBrowser({ tab: tabAt("https://example.com/", "Tab title"), injected });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome.opened).toBe(true);
      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/",
        title: "Tab title",
      });
    });

    it("is used field by field: a value that isn't a string is left out", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/", "Tab title"),
        injected: {
          canonicalUrl: { href: "https://example.com/" },
          description: 7,
          documentTitle: ["not", "a", "string"],
          ogTitle: "Open Graph title",
          ogDescription: null,
          ogSiteName: true,
          unexpected: "https://attacker.example/",
        },
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/",
        title: "Tab title",
        og_title: "Open Graph title",
      });
    });

    it("never lets a value change which page is saved", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/article"),
        injected: { ...metadata(), url: "https://attacker.example/", ogTitle: "Title" },
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/article",
        og_title: "Title",
      });
    });

    it("leaves out a text field with a lone surrogate, keeping the others", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/"),
        injected: metadata({ ogTitle: "broken \ud83d", ogSiteName: "Example" }),
      });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome.opened).toBe(true);
      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/",
        og_site_name: "Example",
      });
    });
  });

  // The empty address is the case a user can reach. Chrome reports `url` as "" while a tab's
  // first page has not arrived yet, for example a link opened in a new tab on a slow server
  // (https://developer.chrome.com/docs/extensions/reference/api/tabs). No active tab,
  // and a tab without `url`, are what the API's types allow.
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
