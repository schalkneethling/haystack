import { normalizeUrl } from "@haystack/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { generateSessionId } from "../src/auth/session-token.ts";
import { seedBookmark, seedSignedInUser, type SeededUser } from "./seed.ts";
import { mainContent, signedOutMainContent } from "./main-content.ts";
import { expectValidHtml } from "./validate-html.ts";
import { createTestWorker } from "./test-worker.ts";

const server = createTestWorker({
  vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
});

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
});

afterAll(async () => {
  await server.close();
});

async function db() {
  return (await server.getWorker().getEnv()).DB;
}

let owner: SeededUser;

beforeEach(async () => {
  const DB = await db();
  await DB.batch([
    DB.prepare("DELETE FROM bookmarks"),
    DB.prepare("DELETE FROM sessions"),
    DB.prepare("DELETE FROM users"),
    DB.prepare("DELETE FROM auth_flows"),
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

function saveUrl(fields: Record<string, string>): string {
  return `/save?${new URLSearchParams(fields).toString()}`;
}

async function getSave(fields: Record<string, string>, cookie: string | null = owner.cookie) {
  return server.fetch(saveUrl(fields), {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// The value of the named form control, as the browser would submit it. Expects `name` before
// `value`, as the Worker renders them.
function formValue(markup: string, name: string): string | undefined {
  const input = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(markup);
  const textarea = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([^<]*)</textarea>`).exec(markup);
  const raw = input?.[1] ?? textarea?.[1];
  return raw?.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

async function rowCounts(): Promise<Record<string, number>> {
  const DB = await db();
  const tables = ["users", "sessions", "auth_flows", "bookmarks"];
  const results = await DB.batch(tables.map((t) => DB.prepare(`SELECT count(*) AS n FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, results[i].results[0].n]));
}

const article = {
  url: "https://example.com/article?utm_source=feed&id=7#top",
  canonical_url: "https://example.com/article?id=7",
  title: "Document title",
  description: "Meta description",
  og_title: "Sharing title",
  og_description: "Sharing description",
  og_site_name: "Example",
};

// Sign-in stores the return target in auth_flows, and a URL that carries a secret is never
// stored, so a link that enters through a signed-out /save is screened before the redirect
// (plan, "Sensitive URLs").
describe("GET /save without a session", () => {
  async function getPath(path: string, cookie: string | null = null) {
    return server.fetch(path, {
      headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
      redirect: "manual",
    });
  }

  it("redirects to sign-in, returning to the same URL", async () => {
    const response = await getSave(article, null);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(saveUrl(article))}`,
    );
  });

  it.each([
    ["an access token", "https://example.com/cb?access_token=secret-value"],
    ["a signed storage URL", "https://bucket.example/f?X-Amz-Signature=secret-value"],
    ["embedded credentials", "https://user:secret-value@example.com/"],
  ])(
    "refuses an address with %s as a signed-in user sees it, without a redirect",
    async (_, url) => {
      const before = await rowCounts();
      const signedOut = await getSave({ url }, null);
      expect(signedOut.status).toBe(400);
      expect(signedOut.headers.get("location")).toBeNull();
      const markup = await signedOut.text();
      expect(markup).not.toContain("secret-value");
      // The same page apart from the header, which has no navigation before sign-in.
      expect(mainContent(markup)).toBe(signedOutMainContent(await (await getSave({ url })).text()));
      expect(markup).not.toContain('action="/auth/sign-out"');
      expect(await rowCounts()).toEqual(before);
      await expectValidHtml(markup);
    },
  );

  it("refuses a sensitive address to a HEAD request, without a redirect", async () => {
    const response = await server.fetch(
      saveUrl({ url: "https://example.com/cb?access_token=secret-value" }),
      { method: "HEAD", headers: { accept: "text/html" }, redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect((await rowCounts()).auth_flows).toBe(0);
  });

  it.each([
    ["is not a stored session", async () => `__Host-session=${generateSessionId()}`],
    [
      "belongs to an expired session",
      async () => {
        await (
          await db()
        )
          .prepare("UPDATE sessions SET expires_at = ?")
          .bind(Date.now() - 1)
          .run();
        return owner.cookie;
      },
    ],
  ])("refuses a sensitive address and clears a cookie that %s", async (_, cookie) => {
    const url = "https://example.com/cb?access_token=secret-value";
    const response = await getSave({ url }, await cookie());
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("__Host-session=; Max-Age=0");
    expect(await response.text()).toContain("access token");
    expect((await rowCounts()).auth_flows).toBe(0);
  });

  // Signing in cannot make an invalid link valid. An invalid link is not screened for secrets,
  // so storing it as a return target could store one. An invalid address gets the address form
  // (#97), and a link whose other fields fail gets the validation page.
  it.each([
    ["an http: URL", saveUrl({ url: "http://example.com/?access_token=secret-value" })],
    [
      "a title over its cap",
      saveUrl({ url: "https://example.com/?access_token=secret-value", title: "a".repeat(201) }),
    ],
  ])("shows the page a signed-in user sees for %s, without a redirect", async (_, path) => {
    const before = await rowCounts();
    const signedOut = await getPath(path);
    expect(signedOut.status).toBe(400);
    expect(signedOut.headers.get("location")).toBeNull();
    const markup = await signedOut.text();
    expect(markup).not.toContain("secret-value");
    const signedIn = await (await getPath(path, owner.cookie)).text();
    expect(mainContent(markup)).toBe(signedOutMainContent(signedIn));
    expect(await rowCounts()).toEqual(before);
  });

  // A link with no captured field carries nothing that could be a secret, and after sign-in it
  // shows the address form (#97). Before #97 a bare /save showed the validation page instead.
  it.each([
    ["no query at all", "/save"],
    ["only an unknown key", "/save?note=secret-value"],
  ])("sends a link with %s to sign-in, returning to /save", async (_, path) => {
    const response = await getPath(path);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/auth/sign-in?return_to=%2Fsave");

    expect((await getPath(location)).status).toBe(302);
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    expect(results).toEqual([{ return_to: "/save" }]);
  });

  it("treats a link that holds only the flag as a bare /save, and stores nothing from it", async () => {
    const response = await getPath("/save?sensitive_canonical_dropped=1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/sign-in?return_to=%2Fsave");
  });

  // The return target is built from the validated payload, without a canonical URL the form
  // leaves out, and encoded by URLSearchParams. The links are written by hand, because the
  // extension never builds one with an unknown or a repeated key, or with untrimmed values.
  const page = "url=https%3A%2F%2Fexample.com%2Farticle%3Fid%3D7";
  const title = "title=Caf%C3%A9+guide";
  const canonical = "canonical_url=https%3A%2F%2Fexample.com%2Farticle";
  const flaggedCanonical = "canonical_url=https%3A%2F%2Fexample.com%2F%3Fapi_key%3Dsecret-value";
  const droppedFlag = "sensitive_canonical_dropped=1";
  it.each([
    // The flag takes the dropped URL's place, at the end, where the extension writes it (#131).
    ["a flagged canonical URL", [page, flaggedCanonical, title], [page, title, droppedFlag]],
    [
      "the flag that a canonical URL was dropped",
      [page, droppedFlag, title],
      [page, title, droppedFlag],
    ],
    [
      "the flag and a flagged canonical URL",
      [page, droppedFlag, flaggedCanonical, title],
      [page, title, droppedFlag],
    ],
    [
      "the flag and a clean canonical URL",
      [page, canonical, droppedFlag, title],
      [page, canonical, title, droppedFlag],
    ],
    [
      "a flag with a value other than 1",
      [page, "sensitive_canonical_dropped=yes", title],
      [page, title],
    ],
    ["an empty flag", [page, "sensitive_canonical_dropped=", title], [page, title]],
    ["an unknown key", [page, "note=secret-value", title], [page, title]],
    [
      "a second url",
      [page, title, "url=https%3A%2F%2Fexample.com%2F%3Faccess_token%3Dsecret-value"],
      [page, title],
    ],
    [
      "a second canonical_url",
      [page, canonical, flaggedCanonical, title],
      [page, canonical, title],
    ],
    [
      "a second flag",
      [page, droppedFlag, "sensitive_canonical_dropped=0", title],
      [page, title, droppedFlag],
    ],
    ["an empty canonical_url", [page, "canonical_url=", title], [page, title]],
    ["a value with spaces around it", [page, "title=+Caf%C3%A9+guide+"], [page, title]],
    ["a space written as %20", [page, "title=Caf%C3%A9%20guide"], [page, title]],
  ])("stores only validated values for a link with %s", async (_, sent, stored) => {
    const path = `/save?${sent.join("&")}`;
    const returnTo = `/save?${stored.join("&")}`;

    const response = await getPath(path);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);

    expect((await getPath(location)).status).toBe(302);
    const { results } = await (await db()).prepare("SELECT return_to FROM auth_flows").all();
    expect(results).toEqual([{ return_to: returnTo }]);

    // After sign-in, the form is the one a signed-in user sees for the link as sent.
    const after = await getPath(returnTo, owner.cookie);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe(await (await getPath(path, owner.cookie)).text());
  });
});

describe("GET /save", () => {
  it("shows the form without writing anything", async () => {
    const before = await rowCounts();
    const response = await getSave(article);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });

  it("shows and submits the URL with tracking parameters removed", async () => {
    const markup = await (await getSave(article)).text();
    expect(markup).toContain(
      '<span id="save-address" class="address">https://example.com/article?id=7#top</span>',
    );
    expect(formValue(markup, "url")).toBe("https://example.com/article?id=7#top");
  });

  it("carries the raw captured values as hidden inputs", async () => {
    const markup = await (await getSave(article)).text();
    for (const name of [
      "canonical_url",
      "title",
      "description",
      "og_title",
      "og_description",
      "og_site_name",
    ]) {
      expect(formValue(markup, name), name).toBe(article[name as keyof typeof article]);
    }
  });

  it.each([
    ["the Open Graph values", article, "Sharing title", "Sharing description"],
    [
      "the document values",
      { url: article.url, title: "Document title", description: "Meta" },
      "Document title",
      "Meta",
    ],
    [
      "the URL when there is no title",
      { url: "https://example.com/a" },
      "https://example.com/a",
      "",
    ],
  ])("prefills from %s", async (_, fields, title, description) => {
    const markup = await (await getSave(fields)).text();
    expect(formValue(markup, "confirmed_title")).toBe(title);
    expect(formValue(markup, "confirmed_description")).toBe(description);
  });

  // The flag that a canonical URL was dropped (#131) is a hidden input of its own, so POST /save
  // can store it. It never holds the canonical URL.
  describe("the flag that a canonical URL was dropped", () => {
    const FLAG = "sensitive_canonical_dropped";
    const flaggedCanonical = "https://example.com/share?api_key=secret-value";

    it.each([
      ["a flagged canonical URL, which the form drops", { canonical_url: flaggedCanonical }],
      ["a link that carries the flag", { [FLAG]: "1" }],
      [
        "a link that carries the flag and a flagged canonical URL",
        { [FLAG]: "1", canonical_url: flaggedCanonical },
      ],
      [
        "a link that carries the flag and a clean canonical URL",
        { [FLAG]: "1", canonical_url: "https://example.com/article" },
      ],
    ])("is a hidden input set to 1 for %s", async (_, extra) => {
      const markup = await (await getSave({ ...article, ...extra })).text();
      expect(formValue(markup, FLAG)).toBe("1");
      expect(markup.match(new RegExp(`name="${FLAG}"`, "g"))).toHaveLength(1);
      expect(markup).not.toContain("secret-value");
      await expectValidHtml(markup);
    });

    it.each([
      ["a clean canonical URL", {}],
      ["a canonical URL that is not an address", { canonical_url: "not a url" }],
      ["a flag with the value 0", { [FLAG]: "0" }],
      ["a flag with the value true", { [FLAG]: "true" }],
      ["an empty flag", { [FLAG]: "" }],
    ])("is not in the form for %s", async (_, extra) => {
      const markup = await (await getSave({ ...article, ...extra })).text();
      expect(markup).not.toContain(`name="${FLAG}"`);
    });
  });

  it("collapses line breaks in the title prefill, keeping the raw value", async () => {
    const markup = await (
      await getSave({ url: "https://example.com/", og_title: "Hello\nWorld" })
    ).text();
    expect(formValue(markup, "confirmed_title")).toBe("Hello World");
    expect(formValue(markup, "og_title")).toBe("Hello\nWorld");
  });

  it("cuts a long URL used as the title to the title cap", async () => {
    const url = `https://example.com/${"a".repeat(300)}`;
    expect(formValue(await (await getSave({ url })).text(), "confirmed_title")).toBe(
      url.slice(0, 200),
    );
  });

  it("does not split an emoji when cutting the URL used as the title", async () => {
    const prefix = `https://example.com/${"a".repeat(179)}`;
    expect(prefix).toHaveLength(199);
    const url = `${prefix}\u{1F600}${"b".repeat(10)}`;
    expect(formValue(await (await getSave({ url })).text(), "confirmed_title")).toBe(prefix);
  });

  it("describes the Save button with the address and the notice", async () => {
    expect(await (await getSave(article)).text()).toContain(
      'aria-describedby="save-address sensitive-notice"',
    );
  });

  it("shows the sensitive URL notice", async () => {
    expect(await (await getSave(article)).text()).toContain(
      "Do not save links that contain access tokens",
    );
  });

  it("renders a title containing markup as text, with the CSP header", async () => {
    const response = await getSave({
      url: "https://example.com/",
      og_title: '<img src=x onerror="alert(1)">',
    });
    const markup = await response.text();
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expectValidHtml(markup);
  });

  // An address that fails gets the address form again (#97), which address-form.test.ts covers
  // in full. These were validation pages before #97.
  it.each([
    ["a javascript: URL", { url: "javascript:alert(1)" }],
    ["a data: URL", { url: "data:text/html,hi" }],
    ["an http: URL", { url: "http://example.com/" }],
    ["no URL", { title: "x" }],
  ])("shows the address form again for %s", async (_, fields) => {
    const response = await getSave(fields);
    expect(response.status).toBe(400);
    const markup = await response.text();
    // The title is the first thing a screen reader announces when the page opens.
    expect(markup).toContain("<title>Check the address - Haystack</title>");
    expect(markup).toContain('<h1><label for="save-url">Save a link</label></h1>');
    await expectValidHtml(markup);
  });

  it("shows a validation page for a title over its cap", async () => {
    const response = await getSave({ url: "https://example.com/", title: "a".repeat(201) });
    expect(response.status).toBe(400);
    const markup = await response.text();
    // The title is the first thing a screen reader announces when the page opens.
    expect(markup).toContain("<title>This link can&#39;t be saved - Haystack</title>");
    expect(markup).toContain("<h1>This link can't be saved</h1>");
    await expectValidHtml(markup);
  });

  it("explains that only https pages are saved, and writes nothing", async () => {
    const before = await rowCounts();
    const markup = await (await getSave({ url: "http://example.com/" })).text();
    expect(markup).toContain(
      '<p id="save-url-error">Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.</p>',
    );
    expect(await rowCounts()).toEqual(before);
  });

  it("explains only the rules for the fields that are invalid", async () => {
    const markup = await (
      await getSave({ url: "https://example.com/", title: "a".repeat(201) })
    ).text();
    expect(markup).toContain("<li>The page title: it is too long</li>");
    expect(markup).not.toContain("https://");
  });

  it.each([
    ["an access token", "https://example.com/cb?access_token=secret-value", "access token"],
    [
      "a signed storage URL",
      "https://bucket.example/f?X-Amz-Signature=secret-value",
      "signed access key",
    ],
    ["embedded credentials", "https://user:secret-value@example.com/", "user name or password"],
  ])("refuses %s without echoing the URL", async (_, url, explanation) => {
    const response = await getSave({ url });
    expect(response.status).toBe(400);
    const markup = await response.text();
    // The address form again (#97), where this was the refusal page before.
    expect(markup).toContain("<title>Check the address - Haystack</title>");
    expect(markup).toContain(explanation);
    expect(markup).not.toContain("secret-value");
    await expectValidHtml(markup);
  });

  // The detect-then-strip order cannot be observed today: no tracking key is also a signal.
  it("refuses a credential parameter next to tracking parameters", async () => {
    const response = await getSave({
      url: "https://example.com/?utm_source=x&api_key=secret-value",
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["a credential parameter", "https://example.com/share?api_key=secret-value"],
    ["a fragment credential", "https://example.com/cb#access_token=secret-value"],
    ["embedded credentials", "https://user:secret-value@example.com/"],
  ])("shows the form without a canonical URL that has %s", async (_, canonical_url) => {
    const response = await getSave({ ...article, canonical_url });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
    expect(markup).not.toContain('name="canonical_url"');
    expect(markup).not.toContain("secret-value");
    expect(formValue(markup, "url")).toBe("https://example.com/article?id=7#top");
    expect(formValue(markup, "og_title")).toBe(article.og_title);
    await expectValidHtml(markup);
  });

  it.each([
    ["the same URL", "https://example.com/article?id=7"],
    ["a URL with tracking parameters", "https://example.com/article?id=7&utm_source=mail"],
    ["a URL with a fragment", "https://example.com/article?id=7#comments"],
  ])("links to the bookmark when %s is already saved", async (_, submitted) => {
    const id = await seedBookmark(
      await db(),
      owner.userId,
      "https://example.com/article?id=7",
      normalizeUrl("https://example.com/article?id=7"),
    );
    const response = await getSave({ url: submitted });
    const markup = await response.text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
    expect(markup).toContain(
      `<a href="/saved-links#bookmark-${id}">See it in your saved links</a>`,
    );
    await expectValidHtml(markup);
  });

  it("does not log the query string", async () => {
    server.clearLogs();
    await getSave({
      url: "https://example.com/private-marker-path",
      title: "private-marker-title",
    });
    await getSave({ url: "javascript:private-marker-invalid" });
    expect(JSON.stringify(server.getLogs())).not.toContain("private-marker");
  });

  it("does not treat another user's bookmark as already saved", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await seedBookmark(
      await db(),
      other.userId,
      "https://example.com/a",
      normalizeUrl("https://example.com/a"),
    );
    const markup = await (await getSave({ url: "https://example.com/a" })).text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
  });
});

// The save link that sign-in returns to after a POST /save whose session had ended (#34). It
// carries the values the user entered, or says that they did not fit in the link.
describe("GET /save after a submission without a session", () => {
  const link = { url: "https://example.com/article", title: "Document title" };
  const KEPT_MESSAGE =
    "This link is not saved yet. Check the title and description, then press Save.";
  const NOT_KEPT_MESSAGE =
    "This link is not saved yet, and its address is too long to keep the title and description with it. Enter them again, then press Save.";

  it("shows the values entered, and says the link is not saved yet", async () => {
    const response = await getSave({
      ...link,
      confirmed_title: "My own title",
      confirmed_description: "My notes\non two lines",
    });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Not saved yet - Haystack</title>");
    expect(markup).toContain(
      `<h1>Save a link</h1>\n      <div id="messages" class="message-bar">\n        <div class="status" role="status"><p>${KEPT_MESSAGE}</p></div>`,
    );
    expect(formValue(markup, "confirmed_title")).toBe("My own title");
    expect(formValue(markup, "confirmed_description")).toBe("My notes\non two lines");
    // The hidden inputs are the captured values only, so a save stores those as before.
    expect(markup).not.toMatch(/type="hidden" name="confirmed_/);
    expect(formValue(markup, "title")).toBe("Document title");
    await expectValidHtml(markup);
  });

  it("keeps an empty description the user entered, rather than the prefill", async () => {
    const markup = await (
      await getSave({
        ...link,
        description: "Meta",
        confirmed_title: "A",
        confirmed_description: "",
      })
    ).text();
    expect(formValue(markup, "confirmed_description")).toBe("");
  });

  it("checks the values as a save does, and shows the error first", async () => {
    const response = await getSave({ ...link, confirmed_title: "   ", confirmed_description: "x" });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<title>Check the form - Haystack</title>");
    expect(markup).toContain(
      '<h1>Save a link</h1>\n      <div id="messages" class="message-bar">\n        <div class="alert" role="alert"><p id="save-error">Enter a title of up to 200 characters.</p></div>\n        <div class="status" role="status">',
    );
    expect(markup).toMatch(
      /id="confirmed-title"[^>]*aria-invalid="true" aria-describedby="save-error"/,
    );
    await expectValidHtml(markup);
  });

  it("says the values were not kept, and starts from the prefill", async () => {
    const response = await getSave({ ...link, confirmed_values: "not-kept" });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Not saved yet - Haystack</title>");
    expect(markup).toContain(`<div class="status" role="status"><p>${NOT_KEPT_MESSAGE}</p></div>`);
    expect(formValue(markup, "confirmed_title")).toBe("Document title");
    await expectValidHtml(markup);
  });

  it("shows an ordinary save link as before", async () => {
    const markup = await (await getSave({ ...link, confirmed_values: "other" })).text();
    expect(markup).toContain("<title>Save a link - Haystack</title>");
    expect(markup).not.toContain('role="status"');
  });

  it("shows that the link is already saved, whatever was entered", async () => {
    await seedBookmark(await db(), owner.userId, link.url, normalizeUrl(link.url));
    const markup = await (await getSave({ ...link, confirmed_title: "Another" })).text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
  });
});
