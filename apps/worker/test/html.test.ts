import { describe, expect, it } from "vite-plus/test";
import { escapeHtml, html, SafeHtml } from "../src/html.ts";

describe("escapeHtml", () => {
  it.each([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
  ])("escapes %s", (char, expected) => {
    expect(escapeHtml(`a${char}b`)).toBe(`a${expected}b`);
  });

  it("escapes & first, so an entity in the input stays visible as text", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("html", () => {
  it("escapes interpolated text", () => {
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

  it("renders numbers", () => {
    expect(html`<p>${42}</p>`.toString()).toBe("<p>42</p>");
  });

  it("returns SafeHtml", () => {
    expect(html`<p></p>`).toBeInstanceOf(SafeHtml);
  });

  it("treats a SafeHtml-looking object as text", () => {
    const fake = { toString: () => "<b>not safe</b>" } as unknown as string;
    expect(html`${fake}`.toString()).toBe("&lt;b&gt;not safe&lt;/b&gt;");
  });
});
