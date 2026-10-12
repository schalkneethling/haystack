import { describe, expect, it } from "vite-plus/test";
import { html, type SafeHtml } from "../src/html.ts";

const characters = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
] as const;

describe("html", () => {
  it.each(characters)("escapes %s in element content", (char, expected) => {
    expect(html`<p>${`a${char}b`}</p>`.toString()).toBe(`<p>a${expected}b</p>`);
  });

  it.each(characters)("escapes %s in a quoted attribute value", (char, expected) => {
    expect(html`<a title="${`a${char}b`}">x</a>`.toString()).toBe(`<a title="a${expected}b">x</a>`);
  });

  it("escapes & first, so an entity in the input stays visible as text", () => {
    expect(html`${"&lt;"}`.toString()).toBe("&amp;lt;");
  });

  it("keeps script in text inert", () => {
    expect(html`<p>${"<script>alert(1)</script>"}</p>`.toString()).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("keeps an attribute value inside its quotes", () => {
    const value = '" onmouseover="alert(1)';
    expect(html`<a title="${value}">x</a>`.toString()).toBe(
      '<a title="&quot; onmouseover=&quot;alert(1)">x</a>',
    );
  });

  it("does not double-escape nested html", () => {
    const inner = html`<em>${"a&b"}</em>`;
    expect(html`<p>${inner}</p>`.toString()).toBe("<p><em>a&amp;b</em></p>");
  });

  it("joins arrays, escaping strings and keeping html", () => {
    const items = ["<a>", html`<li>b</li>`];
    expect(html`<ul>${items}</ul>`.toString()).toBe("<ul>&lt;a&gt;<li>b</li></ul>");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
  ] as const)("renders %s as nothing", (_, value) => {
    expect(html`<p>${value}</p>`.toString()).toBe("<p></p>");
  });

  it("renders finite numbers", () => {
    expect(html`<p>${42}</p>`.toString()).toBe("<p>42</p>");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (value) => {
    expect(() => html`<p>${value}</p>`).toThrow(TypeError);
  });

  it("escapes an object that only looks like html", () => {
    const fake = { toString: () => "<b>not safe</b>" } as unknown as SafeHtml;
    expect(html`${fake}`.toString()).toBe("&lt;b&gt;not safe&lt;/b&gt;");
  });

  it("escapes a fragment built with the constructor instead of html", () => {
    const Fragment = Object.getPrototypeOf(html``).constructor as new (markup: string) => SafeHtml;
    expect(html`${new Fragment("<b>raw</b>")}`.toString()).toBe("&lt;b&gt;raw&lt;/b&gt;");
  });
});
