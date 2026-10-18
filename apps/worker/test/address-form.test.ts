// The "Save a link" address form (#97): on the saved links page, on a bare /save, and again
// with an error when GET /save rejects an address. See "Save flow" in
// plans/haystack-v1-implementation-plan.md.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { mainContent } from "./main-content.ts";
import { seedSignedInUser, type SeededUser } from "./seed.ts";
import { expectValidHtml } from "./validate-html.ts";

const server = createTestHarness({
  workers: [
    {
      configPath: new URL("../wrangler.jsonc", import.meta.url),
      vars: { ALLOWED_EMAILS: "owner@example.com" },
    },
  ],
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

async function get(path: string, cookie: string | null = owner.cookie) {
  return server.fetch(path, {
    headers: { accept: "text/html", ...(cookie === null ? {} : { cookie }) },
    redirect: "manual",
  });
}

function saveUrl(fields: Record<string, string>): string {
  return `/save?${new URLSearchParams(fields).toString()}`;
}

async function rowCounts(): Promise<Record<string, number>> {
  const DB = await db();
  const tables = ["sessions", "auth_flows", "bookmarks"];
  const results = await DB.batch(tables.map((t) => DB.prepare(`SELECT count(*) AS n FROM ${t}`)));
  return Object.fromEntries(tables.map((t, i) => [t, results[i].results[0].n]));
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** The address field's attributes, with their values unescaped. Fails when there is no field. */
function addressField(markup: string): Map<string, string> {
  const tag = /<input id="save-url"[^>]*>/.exec(markup)?.[0];
  if (tag === undefined) {
    throw new Error("The page has no address field");
  }
  return new Map(
    [...tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)]
      .slice(1)
      .map(([, name = "", value = ""]) => [
        name,
        value.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity),
      ]),
  );
}

const HINT =
  '<p id="save-url-hint" class="hint">Paste the address of a page. You confirm its title on the next step.</p>';

// The field and its form, as both places render them. The browser's own checks are off and the
// field is not required, so every error comes from the server (address-form.ts says why).
function expectAddressForm(markup: string): void {
  expect(markup).toContain(
    '<form class="panel address-form" method="get" action="/save" novalidate>',
  );
  expect(markup).toContain(HINT);
  expect(markup).toContain('<button class="button button-primary" type="submit">Continue</button>');
  const field = addressField(markup);
  expect(field.get("name")).toBe("url");
  expect(field.get("type")).toBe("url");
  expect(field.get("autocomplete")).toBe("url");
  expect(field.has("required")).toBe(false);
  expect(field.has("placeholder")).toBe(false);
  expect(markup).not.toContain("style=");
}

function expectNoError(markup: string): void {
  const field = addressField(markup);
  expect(field.get("aria-describedby")).toBe("save-url-hint");
  expect(field.has("aria-invalid")).toBe(false);
  expect(field.has("value")).toBe(false);
  expect(markup).not.toContain('role="alert"');
}

describe("the address form", () => {
  it("is at the top of the saved links page, labelled as the design shows it", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    const markup = await response.text();
    expectAddressForm(markup);
    expectNoError(markup);
    expect(markup).toContain(
      '<label class="address-form-title" for="save-url">Save a link</label>',
    );
    // Before the page heading.
    const main = mainContent(markup);
    expect(main.indexOf("<form")).toBeLessThan(main.indexOf("<h1"));
    await expectValidHtml(markup);
  });

  it.each([
    ["a bare /save", "/save"],
    ["an empty query", "/save?"],
    ["a query with no captured field", "/save?note=hello"],
  ])("is the page for %s, with its label as the heading", async (_, path) => {
    const before = await rowCounts();
    const response = await get(path);
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain("<title>Save a link - Haystack</title>");
    expect(markup).toContain('<h1><label for="save-url">Save a link</label></h1>');
    expect(markup).toContain("Do not save links that contain access tokens");
    expect(markup).not.toContain("can&#39;t be saved");
    expectAddressForm(markup);
    expectNoError(markup);
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });

  // The form submits GET /save with only `url`, which is the save form for that address.
  it("submits to the save form for the address", async () => {
    const response = await get(saveUrl({ url: "https://example.com/typed" }));
    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('<form class="panel" method="post" action="/save">');
    expect(markup).toContain(
      '<span id="save-address" class="address">https://example.com/typed</span>',
    );
  });
});

const ADDRESS_RULE =
  "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long.";

// The error after the heading, in the alert pattern the save form uses, and tied to the field.
function expectError(markup: string, message: string): void {
  expect(markup).toContain("<title>Check the address - Haystack</title>");
  expect(markup).toContain(
    `<h1><label for="save-url">Save a link</label></h1><div class="alert" role="alert"><p id="save-url-error">${message}</p></div>`,
  );
  const field = addressField(markup);
  expect(field.get("aria-invalid")).toBe("true");
  expect(field.get("aria-describedby")).toBe("save-url-error save-url-hint");
}

describe("an address the checks reject", () => {
  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,hi"],
    ["an http: URL", "http://example.com/page"],
    ["an address without a scheme", "example.com/page"],
    ["an address with a space", "https://example.com/a page"],
    ["an address over its cap", `https://example.com/${"a".repeat(2048)}`],
  ])("shows the form again for %s, with the error and the typed value", async (_, url) => {
    const before = await rowCounts();
    const response = await get(saveUrl({ url }));
    expect(response.status).toBe(400);
    const markup = await response.text();
    expectAddressForm(markup);
    expectError(markup, ADDRESS_RULE);
    expect(addressField(markup).get("value")).toBe(url);
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });

  it("escapes the typed value", async () => {
    const markup = await (await get(saveUrl({ url: 'javascript:"><img src=x>' }))).text();
    expect(markup).not.toContain("<img");
    expect(addressField(markup).get("value")).toBe('javascript:"><img src=x>');
    await expectValidHtml(markup);
  });

  it.each([
    ["an empty address", ""],
    ["an address of spaces", "   "],
  ])("asks for an address for %s", async (_, url) => {
    const markup = await (await get(saveUrl({ url }))).text();
    expectError(markup, "Enter the address of a page, starting with https://.");
    expect(addressField(markup).has("value")).toBe(false);
    await expectValidHtml(markup);
  });

  // The refusal page never shows the link (plan, "Sensitive URLs"), so neither does the form.
  it.each([
    [
      "an access token",
      "https://example.com/cb?access_token=secret-value",
      "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
    ],
    [
      "a signed storage URL",
      "https://bucket.example/f?X-Amz-Signature=secret-value",
      "This link contains a signed access key, so it could let anyone who has it download the file.",
    ],
    [
      "embedded credentials",
      "https://user:secret-value@example.com/",
      "This link contains a user name or password, so anyone who has it could sign in with them.",
    ],
    // Invalid, so validation alone would put it back in the field.
    [
      "an http: URL with an access token",
      "http://example.com/cb?access_token=secret-value",
      "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
    ],
  ])("shows the reason for %s, without echoing the address", async (_, url, reason) => {
    const before = await rowCounts();
    const response = await get(saveUrl({ url }));
    expect(response.status).toBe(400);
    const markup = await response.text();
    expectAddressForm(markup);
    expectError(markup, reason);
    expect(addressField(markup).has("value")).toBe(false);
    expect(markup).not.toContain("secret-value");
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });

  // GET /save is one route, so a link from the extension or by hand gets the same page.
  it.each([
    ["a flagged address", "https://example.com/cb?access_token=secret-value"],
    ["an invalid address", "http://example.com/page"],
  ])("shows the address form for a link with %s and other fields", async (_, url) => {
    const fields = { url, title: "A page", og_site_name: "Example" };
    const response = await get(saveUrl(fields));
    expect(response.status).toBe(400);
    expect(mainContent(await response.text())).toBe(
      mainContent(await (await get(saveUrl({ url }))).text()),
    );
  });

  // The address form has no field for the others, so they keep the validation page, which lists
  // each one. Only a hand-built link has them: the extension leaves an invalid field out.
  it("keeps the validation page for a link whose address passes and other fields fail", async () => {
    const response = await get(
      saveUrl({
        url: "https://example.com/",
        canonical_url: "ftp://example.com/",
        title: "a".repeat(201),
        og_site_name: "a".repeat(201),
      }),
    );
    expect(response.status).toBe(400);
    const markup = await response.text();
    expect(markup).toContain("<h1>This link can't be saved</h1>");
    expect(markup).toContain(
      "<li>The page&#39;s canonical address: it must be a complete http:// or https:// link, without spaces and at most 2,048 characters long</li>",
    );
    expect(markup).toContain("<li>The page title: it is too long</li>");
    expect(markup).toContain("<li>The site name: it is too long</li>");
    expect(markup).not.toContain('id="save-url"');
    await expectValidHtml(markup);
  });

  it("shows the address form when the address and another field both fail", async () => {
    const url = "http://example.com/page";
    const markup = await (await get(saveUrl({ url, title: "a".repeat(201) }))).text();
    expectError(markup, ADDRESS_RULE);
    expect(addressField(markup).get("value")).toBe(url);
  });

  it.each([
    ["an invalid address", "http://example.com/page"],
    ["a flagged address", "https://example.com/cb?access_token=secret-value"],
  ])("shows the same form before sign-in for %s, without a redirect", async (_, url) => {
    const before = await rowCounts();
    const response = await get(saveUrl({ url }), null);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const markup = await response.text();
    expect(mainContent(markup)).toBe(mainContent(await (await get(saveUrl({ url }))).text()));
    expect(markup).not.toContain('action="/auth/sign-out"');
    expect(await rowCounts()).toEqual(before);
    await expectValidHtml(markup);
  });
});
