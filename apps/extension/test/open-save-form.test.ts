import { CAPTURE_CAPS, SAVE_URL_BUDGET, SENSITIVE_URL_EXPLANATIONS } from "@haystack/schemas";
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

    it.each([
      ["a credential parameter", "https://example.com/share?api_key=secret-value"],
      ["a fragment credential", "https://example.com/cb#access_token=secret-value"],
      ["embedded credentials", "https://user:secret-value@example.com/"],
      ["an http scheme", "http://example.com/?password=secret-value"],
    ])("is dropped when it has %s, and the page is still saved", async (_, canonicalUrl) => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/article"),
        injected: metadata({ canonicalUrl, ogTitle: "Kept" }),
      });

      const outcome = await openSaveForm(fake.api, ORIGIN);

      expect(outcome.opened).toBe(true);
      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/article",
        og_title: "Kept",
      });
      expect(fake.created[0]).not.toContain("secret-value");
    });

    it("is dropped for a secret even after another field was dropped as invalid", async () => {
      const fake = fakeBrowser({
        tab: tabAt("https://example.com/article"),
        injected: metadata({
          canonicalUrl: "https://example.com/share?api_key=secret-value",
          ogSiteName: "\ud800",
          documentTitle: "Kept",
        }),
      });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "")).toEqual({
        url: "https://example.com/article",
        title: "Kept",
      });
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

describe("the save URL's length budget", () => {
  // The optional fields in the order the plan drops them, written out here on purpose so that
  // a change to the order in the popup fails a test.
  const DROP_ORDER = [
    "og_description",
    "description",
    "og_title",
    "og_site_name",
    "canonical_url",
  ] as const;

  type Fields = Record<string, string>;

  // The length of the save URL for these query fields, built the way a browser serializes a
  // query (`URLSearchParams`), with the origin and `/save?` counted.
  function lengthOf(fields: Fields): number {
    return `${ORIGIN}/save?${new URLSearchParams(fields).toString()}`.length;
  }

  // Text that encodes to exactly `chars` characters in a save URL: each "€" (three UTF-8
  // bytes) to nine, and each "x" to one.
  function encodedText(chars: number): string {
    return "€".repeat(Math.floor(chars / 9)) + "x".repeat(chars % 9);
  }

  // How many characters a value takes in a save URL, without its name.
  function encodedLength(value: string): number {
    return new URLSearchParams({ a: value }).toString().length - "a=".length;
  }

  const PREFIX = "https://example.com/";

  // An https address that encodes to exactly `chars` characters, at least the prefix's: each
  // "/" encodes to three, and "a" to one.
  function address(chars: number, prefix = PREFIX): string {
    const rest = chars - encodedLength(prefix);
    return `${prefix}${"/".repeat(Math.floor(rest / 3))}${"a".repeat(rest % 3)}`;
  }

  // Maps the payload's query names back to what the page returns.
  function pageMetadata(fields: Fields): PageMetadata {
    return metadata({
      canonicalUrl: fields.canonical_url ?? null,
      description: fields.description ?? null,
      documentTitle: fields.title ?? "",
      ogTitle: fields.og_title ?? null,
      ogDescription: fields.og_description ?? null,
      ogSiteName: fields.og_site_name ?? null,
    });
  }

  // Every field a page can give, each at a size that leaves room to tune the total with the
  // address. The sizes are encoded characters.
  function everyField(overrides: Fields = {}): Fields {
    return {
      canonical_url: address(1200, "https://example.com/canonical"),
      title: encodedText(1800),
      description: encodedText(900),
      og_title: encodedText(900),
      og_description: encodedText(900),
      og_site_name: encodedText(450),
      ...overrides,
    };
  }

  // A page whose save URL is exactly `total` characters once the fields in `gone` are left
  // out, with the address sized to make it so.
  function pageAt(total: number, gone: readonly string[], overrides: Fields = {}) {
    const fields = everyField(overrides);
    const remaining = { ...fields };
    for (const field of gone) {
      delete remaining[field];
    }
    const shortest = lengthOf({ url: PREFIX, ...remaining });
    const url = address(encodedLength(PREFIX) + total - shortest);
    expect(lengthOf({ url, ...remaining })).toBe(total);
    return { url, fields };
  }

  async function open(url: string, fields: Fields) {
    const fake = fakeBrowser({ tab: tabAt(url), injected: pageMetadata(fields) });
    const outcome = await openSaveForm(fake.api, ORIGIN);
    expect(outcome.opened).toBe(true);
    const saved = fake.created[0] ?? "";
    return { saved, parameters: saveParameters(saved) };
  }

  // What the save URL carries once `dropped` optional fields of the order are gone, and the
  // fields in `alsoGone`.
  function without(
    fields: Fields,
    url: string,
    dropped: number,
    alsoGone: readonly string[] = [],
  ): Fields {
    const kept: Fields = { url, ...fields };
    for (const field of [...DROP_ORDER.slice(0, dropped), ...alsoGone]) {
      delete kept[field];
    }
    return kept;
  }

  it("is the 8,000 characters the plan sets", () => {
    expect(SAVE_URL_BUDGET).toBe(8000);
  });

  describe("drops the optional fields in order, and stops as soon as the URL fits", () => {
    // `dropped` is how many fields of the order have to go for the URL to fit. A URL of exactly
    // the budget fits, and one more character does not.
    const rows = DROP_ORDER.flatMap((_, dropped) => [
      { dropped, total: SAVE_URL_BUDGET, goes: dropped },
      { dropped, total: SAVE_URL_BUDGET + 1, goes: dropped + 1 },
    ]);

    it.each(rows)(
      "drops $goes field(s) when the URL is $total characters after $dropped",
      async ({ dropped, total, goes }) => {
        const { url, fields } = pageAt(total, DROP_ORDER.slice(0, dropped));

        const { saved, parameters } = await open(url, fields);

        expect(parameters).toEqual(without(fields, url, goes));
        expect(saved.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
      },
    );

    it("leaves a URL that is under the budget as it is", async () => {
      const { url, fields } = pageAt(SAVE_URL_BUDGET - 500, []);

      const { parameters } = await open(url, fields);

      expect(parameters).toEqual({ url, ...fields });
    });

    it("sends the address and the title when every optional field has to go", async () => {
      const { url, fields } = pageAt(SAVE_URL_BUDGET + 1, DROP_ORDER.slice(0, -1));

      const { parameters } = await open(url, fields);

      expect(parameters).toEqual({ url, title: fields.title });
    });
  });

  describe("never drops or cuts the address", () => {
    it("fits an address at its cap with the longest title, and drops the rest", async () => {
      const url = `https://example.com/${"/".repeat(CAPTURE_CAPS.url - "https://example.com/".length)}`;
      expect(url).toHaveLength(CAPTURE_CAPS.url);
      const fields = {
        canonical_url: address(2000),
        title: "€".repeat(CAPTURE_CAPS.title),
        description: "€".repeat(CAPTURE_CAPS.description),
        og_title: "€".repeat(CAPTURE_CAPS.og_title),
        og_description: "€".repeat(CAPTURE_CAPS.og_description),
        og_site_name: "€".repeat(CAPTURE_CAPS.og_site_name),
      };

      const { saved, parameters } = await open(url, fields);

      expect(parameters).toEqual({ url, title: fields.title });
      expect(saved.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
    });

    it("fits an address at its cap on its own", async () => {
      const url = `https://example.com/${"/".repeat(CAPTURE_CAPS.url - "https://example.com/".length)}`;
      const fake = fakeBrowser({ tab: tabAt(url), injected: metadata() });

      await openSaveForm(fake.api, ORIGIN);

      expect(saveParameters(fake.created[0] ?? "")).toEqual({ url });
      expect(fake.created[0]?.length).toBeLessThanOrEqual(SAVE_URL_BUDGET);
    });
  });

  describe("measures text as it is encoded", () => {
    // Each kind is padded between two letters so that it survives trimming. A space is one
    // character in a query ("+"), and the others are two, six, nine and twelve once
    // percent-encoded. A measure of the raw text, or of `encodeURIComponent`'s output for a
    // space ("%20"), gets the total wrong, so the exact boundary shows it.
    const kinds = [
      ["spaces", " ", 250],
      ["accented letters", "é", 140],
      ["Chinese characters", "字", 90],
      ["emoji", "😀", 50],
    ] as const;

    for (const [kind, character, count] of kinds) {
      const description = `a${character.repeat(count)}a`;

      it(`keeps ${kind} at exactly the budget`, async () => {
        const { url, fields } = pageAt(SAVE_URL_BUDGET, [], { og_description: description });

        const { parameters } = await open(url, fields);

        expect(parameters.og_description).toBe(description);
      });

      it(`drops the next field for ${kind} one character over the budget`, async () => {
        const { url, fields } = pageAt(SAVE_URL_BUDGET + 1, [], { og_description: description });

        const { parameters } = await open(url, fields);

        expect(parameters).toEqual(without(fields, url, 1));
      });
    }
  });

  describe("runs on the payload that is sent", () => {
    it("counts a canonical URL that carries a secret as already gone", async () => {
      // With this canonical URL the save URL is over the budget by its size. It is dropped
      // for the secret, so the fields that would otherwise go are kept.
      const secret = address(1200, "https://example.com/?api_key=secret-value");
      const { url, fields } = pageAt(SAVE_URL_BUDGET, ["canonical_url"], {
        canonical_url: secret,
      });
      expect(lengthOf({ url, ...fields })).toBeGreaterThan(SAVE_URL_BUDGET);

      const { saved, parameters } = await open(url, fields);

      expect(parameters).toEqual(without(fields, url, 0, ["canonical_url"]));
      expect(saved).not.toContain("secret-value");
    });
  });
});
