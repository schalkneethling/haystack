import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      vars: { ALLOWED_EMAILS: "owner@example.com, second@example.com" },
    },
  ],
});
let origin: string;

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
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
  ]);
  owner = await seedSignedInUser(DB, "owner@example.com");
});

// What the form from GET /save submits for this captured page.
const submission = {
  url: "https://example.com/article?id=7",
  canonical_url: "https://example.com/article?id=7",
  title: "Document title",
  description: "Meta description",
  og_title: "Sharing title",
  og_description: "Sharing description",
  og_site_name: "Example",
  confirmed_title: "  My title  ",
  confirmed_description: "My description",
};

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return server.fetch("/save", {
    method: "POST",
    headers: { origin, cookie: owner.cookie, ...headers },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function bookmarks(): Promise<Record<string, unknown>[]> {
  const { results } = await (await db()).prepare("SELECT * FROM bookmarks").all();
  return results;
}

describe("POST /save", () => {
  it("creates the bookmark under the signed-in user with the confirmed values", async () => {
    const response = await post(submission);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Saved</h1>");
    await expectValidHtml(markup);

    const [bookmark] = await bookmarks();
    expect(bookmark).toMatchObject({
      user_id: owner.userId,
      url: "https://example.com/article?id=7",
      normalized_url: "https://example.com/article?id=7",
      title: "My title",
      description: "My description",
      canonical_url: "https://example.com/article?id=7",
      captured_title: "Document title",
      captured_description: "Meta description",
      og_title: "Sharing title",
      og_description: "Sharing description",
      og_site_name: "Example",
    });
    expect(bookmark?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(markup).toContain(`href="/#bookmark-${String(bookmark?.id)}"`);
  });

  it("stores no description when the confirmed description is empty", async () => {
    await post({ ...submission, confirmed_description: "   " });
    expect((await bookmarks())[0]?.description).toBeNull();
  });

  it("counts a submitted line break (CRLF) as one character, as the form's maxlength does", async () => {
    const description = "ab\r\n".repeat(100);
    expect(description).toHaveLength(400);
    const response = await post({ ...submission, confirmed_description: description });
    expect(response.status).toBe(200);
    expect((await bookmarks())[0]?.description).toBe("ab\n".repeat(100).trim());
  });

  it("accepts captured values whose line breaks arrive as CRLF, storing them as GET showed them", async () => {
    // GET rendered a 300-character description with 10 LF line breaks into a hidden input;
    // the browser submits each as CRLF, so the value arrives 10 characters longer.
    const shown = `${"a".repeat(29)}\n`.repeat(10);
    expect(shown).toHaveLength(300);
    const response = await post({ ...submission, description: shown.replaceAll("\n", "\r\n") });
    expect(response.status).toBe(200);
    expect((await bookmarks())[0]?.captured_description).toBe(shown.trim());
  });

  it("collapses line breaks in a tampered confirmed title", async () => {
    await post({ ...submission, confirmed_title: "Two\r\nlines" });
    expect((await bookmarks())[0]?.title).toBe("Two lines");
  });

  it.each([
    ["a JSON body", "application/json", JSON.stringify(submission)],
    ["a plain text body", "text/plain", "hello"],
  ])("answers %s with a 400 page", async (_, contentType, body) => {
    const response = await server.fetch("/save", {
      method: "POST",
      headers: { origin, cookie: owner.cookie, "content-type": contentType },
      body,
    });
    expect(response.status).toBe(400);
    await expectValidHtml(await response.text());
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    [
      "an empty title",
      { confirmed_title: "   " },
      "confirmed-title",
      "Enter a title of up to 200 characters.",
    ],
    [
      "a title over its cap",
      { confirmed_title: "a".repeat(201) },
      "confirmed-title",
      "Enter a title of up to 200 characters.",
    ],
    [
      "a description over its cap",
      { confirmed_description: "a".repeat(301) },
      "confirmed-description",
      "Shorten the description to 300 characters or fewer.",
    ],
  ])("shows the form again for %s, keeping the values", async (_, fields, id, message) => {
    const response = await post({ ...submission, ...fields });
    expect(response.status).toBe(400);
    const markup = await response.text();
    // The alert wraps the error. The paragraph the field points at has no live-region role of its
    // own, because VoiceOver does not read the description of such an element.
    expect(markup).toContain(
      `<div class="alert" role="alert"><p id="save-error">${message}</p></div>`,
    );
    expect(markup).toMatch(
      new RegExp(`id="${id}"[^>]*aria-invalid="true" aria-describedby="save-error"`),
    );
    expect(markup).toContain('name="og_title" value="Sharing title"');
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(0);
  });

  it("removes tracking parameters, even when the hidden input was tampered with", async () => {
    await post({ ...submission, url: "https://example.com/article?id=7&utm_source=mail&fbclid=x" });
    expect((await bookmarks())[0]?.url).toBe("https://example.com/article?id=7");
  });

  it("ignores a user_id in the form", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await post({ ...submission, user_id: other.userId });
    expect((await bookmarks())[0]?.user_id).toBe(owner.userId);
  });

  it("lets two users save the same URL independently", async () => {
    const other = await seedSignedInUser(await db(), "second@example.com");
    await post(submission);
    await post(submission, { cookie: other.cookie });
    expect(new Set((await bookmarks()).map((b) => b.user_id))).toEqual(
      new Set([owner.userId, other.userId]),
    );
  });

  it("shows already saved for a URL the user saved before", async () => {
    await post(submission);
    const response = await post({ ...submission, url: "https://example.com/article?id=7#again" });
    const markup = await response.text();
    expect(markup).toContain("<h1>You already saved this link</h1>");
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(1);
  });

  it("gives one bookmark and an already-saved result for two concurrent submissions", async () => {
    const responses = await Promise.all([post(submission), post(submission)]);
    const headings = await Promise.all(
      responses.map(async (r) => /<h1>([^<]*)<\/h1>/.exec(await r.text())?.[1]),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(headings)).toEqual(new Set(["Saved", "You already saved this link"]));
    expect(await bookmarks()).toHaveLength(1);
  });

  it.each([
    ["without a session", { cookie: "" }, 401],
    ["from another origin", { origin: "https://evil.example" }, 403],
  ])("is rejected %s", async (_, headers, status) => {
    const response = await post(submission, headers);
    expect(response.status).toBe(status);
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    ["a javascript: URL", { url: "javascript:alert(1)" }],
    ["a data: URL", { url: "data:text/html,hi" }],
    ["an http: URL", { url: "http://example.com/" }],
  ])("rejects %s", async (_, fields) => {
    const response = await post({ ...submission, ...fields });
    expect(response.status).toBe(400);
    await expectValidHtml(await response.text());
    expect(await bookmarks()).toHaveLength(0);
  });

  // The detect-then-strip order cannot be observed today: no tracking key is also a signal.
  it("refuses a tampered sensitive URL without echoing it", async () => {
    const response = await post({
      ...submission,
      url: "https://example.com/cb?utm_source=x&access_token=secret-value",
    });
    expect(response.status).toBe(400);
    const markup = await response.text();
    // A POST keeps the refusal page. Only GET /save shows the address form (#97), because the
    // form's own hidden inputs always pass the checks.
    expect(markup).toContain("<h1>This link can't be saved</h1>");
    expect(markup).not.toContain('id="save-url"');
    expect(markup).not.toContain("secret-value");
    await expectValidHtml(markup);
    expect(await bookmarks()).toHaveLength(0);
  });

  it.each([
    ["a credential parameter", "https://example.com/share?api_key=secret-value"],
    ["a fragment credential", "https://example.com/cb#access_token=secret-value"],
    ["embedded credentials", "https://user:secret-value@example.com/"],
  ])("saves the bookmark without a canonical URL that has %s", async (_, canonical_url) => {
    const response = await post({ ...submission, canonical_url });
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<h1>Saved</h1>");
    expect(markup).not.toContain("secret-value");

    const rows = await bookmarks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: "https://example.com/article?id=7",
      canonical_url: null,
      captured_title: "Document title",
      og_title: "Sharing title",
    });
    expect(JSON.stringify(rows)).not.toContain("secret-value");
  });

  it("shows the form again without the flagged canonical URL when the title is empty", async () => {
    const response = await post({
      ...submission,
      canonical_url: "https://example.com/share?api_key=secret-value",
      confirmed_title: "",
    });
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
    expect(markup).not.toContain('name="canonical_url"');
    expect(markup).not.toContain("secret-value");
    expect(await bookmarks()).toHaveLength(0);
  });
});

// A form submission asks for HTML, as a browser's navigation does, while the site's scripts never
// do. Without a session, the form is sent through sign-in and back to itself with what the user
// entered (#34). A script still gets the 401 above.
describe("POST /save from the form without a session", () => {
  const HTML = { accept: "text/html,application/xhtml+xml", cookie: "" };

  // The return target in the sign-in redirect, as sign-in reads it.
  function returnTarget(response: Response): string {
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "", origin);
    expect(location.pathname).toBe("/auth/sign-in");
    return location.searchParams.get("return_to") ?? "";
  }

  it("returns to the save link with the values entered, normalized as a save would store them", async () => {
    const response = await post(
      { ...submission, confirmed_description: "Line one\r\nline two  " },
      HTML,
    );
    const { url, canonical_url, title, description, og_title, og_description, og_site_name } =
      submission;
    expect(returnTarget(response)).toBe(
      `/save?${new URLSearchParams({
        url,
        canonical_url,
        title,
        description,
        og_title,
        og_description,
        og_site_name,
        confirmed_title: "My title",
        confirmed_description: "Line one\nline two",
      }).toString()}`,
    );
    expect(await bookmarks()).toHaveLength(0);
  });

  // A form with enctype="multipart/form-data" sends this encoding, which formData() reads too.
  // The harness would send a FormData body as text/plain, so the body is encoded here, with its
  // boundary in the content type.
  it("reads a multipart form submission the same way", async () => {
    const form = new FormData();
    for (const [name, value] of Object.entries(submission)) {
      form.append(name, value);
    }
    const encoded = new Request("https://encoder.invalid/", { method: "POST", body: form });
    const contentType = encoded.headers.get("content-type") ?? "";
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const response = await server.fetch("/save", {
      method: "POST",
      headers: { ...HTML, origin, "content-type": contentType },
      body: await encoded.arrayBuffer(),
      redirect: "manual",
    });
    const target = new URL(returnTarget(response), origin);
    expect(target.searchParams.get("url")).toBe(submission.url);
    expect(target.searchParams.get("og_title")).toBe(submission.og_title);
    expect(target.searchParams.get("confirmed_title")).toBe("My title");
    expect(target.searchParams.get("confirmed_description")).toBe("My description");
  });

  it("clears a session cookie that is no longer valid", async () => {
    const response = await post(submission, { ...HTML, cookie: "__Host-session=ended" });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=; Max-Age=0");
  });

  it("drops a flagged canonical URL from the return target, as the form does", async () => {
    const response = await post(
      { ...submission, canonical_url: "https://example.com/share?api_key=secret-value" },
      HTML,
    );
    const target = new URL(returnTarget(response), origin);
    expect(target.searchParams.has("canonical_url")).toBe(false);
    expect(target.href).not.toContain("secret-value");
  });

  // Only a tampered or hand-built submission carries a flagged address. It gets the page a
  // signed-out GET /save of that link gets, and no Location header or stored row carries it.
  it("answers a tampered address that carries a secret with its page, and no redirect", async () => {
    const response = await post(
      { ...submission, url: "https://example.com/cb?access_token=secret-value" },
      HTML,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const markup = await response.text();
    expect(markup).toContain("This link contains an access token, key, or password");
    expect(markup).not.toContain("secret-value");
    const { results } = await (await db()).prepare("SELECT * FROM auth_flows").all();
    expect(results).toHaveLength(0);
  });

  // The values must keep the save link within SAVE_URL_BUDGET, which keeps the sign-in redirect
  // under Cloudflare's URL limit (save-url-budget.test.ts).
  it("says the values were not kept when they would take the save link over its budget", async () => {
    // The save link without the values is about 6,400 characters, because each "/" is encoded
    // as "%2F", and each "語" the values add is encoded in nine.
    const long = {
      ...submission,
      url: `https://example.com/${"/".repeat(2000)}`,
      confirmed_title: "語".repeat(200),
      confirmed_description: "語".repeat(300),
    };
    const target = new URL(returnTarget(await post(long, HTML)), origin);
    expect(target.searchParams.has("confirmed_title")).toBe(false);
    expect(target.searchParams.has("confirmed_description")).toBe(false);
    expect(target.searchParams.get("confirmed_values")).toBe("not-kept");
    expect(target.searchParams.get("url")).toBe(long.url);
  });

  it("returns to the address form for a body that is not a form", async () => {
    const response = await server.fetch("/save", {
      method: "POST",
      headers: { ...HTML, origin, "content-type": "application/json" },
      body: JSON.stringify(submission),
      redirect: "manual",
    });
    expect(returnTarget(response)).toBe("/save");
  });

  it("still gets 403 from another origin, before anything else", async () => {
    const response = await post(submission, { ...HTML, origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each([
    ["JSON", "application/json"],
    ["anything, as fetch() asks by default", "*/*"],
  ])("still answers 401 to a request that asks for %s", async (_, accept) => {
    const response = await post(submission, { accept, cookie: "" });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });
});
