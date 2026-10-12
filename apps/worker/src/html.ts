// The only way the Worker builds HTML. See "Untrusted content" in
// plans/haystack-v1-implementation-plan.md: captured titles, descriptions, and URLs come from
// pages anyone can write, so every interpolated value is escaped unless it came from `html`.

declare const safeHtmlBrand: unique symbol;

/** HTML produced by `html`. Only `html` can create one; there is no way to wrap a raw string. */
export interface SafeHtml {
  readonly [safeHtmlBrand]: true;
  toString(): string;
}

class Fragment {
  readonly #markup: string;

  constructor(markup: string) {
    this.#markup = markup;
  }

  toString(): string {
    return this.#markup;
  }
}

// Fragments created by `html`. Checking membership, not `instanceof`, means a value built with
// the constructor (reachable through any fragment) or a subclass is still escaped as text.
const fragments = new WeakSet<object>();

type HtmlValue = SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (typeof value === "object" && fragments.has(value)) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("html: only finite numbers can be rendered");
  }
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value. Nested `html` results and arrays of
 * them are inserted as they are; `null`, `undefined`, and `false` render as nothing.
 *
 * Supported positions: element content and quoted attribute values (`title="${value}"`).
 * Not supported: unquoted attributes, and content inside `<script>` or `<style>`.
 * Escaping does not make a URL safe: a `javascript:` URL survives it. A URL in an attribute
 * such as `href` must already be validated as http or https.
 */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  const fragment = new Fragment(out);
  fragments.add(fragment);
  return fragment as unknown as SafeHtml;
}
