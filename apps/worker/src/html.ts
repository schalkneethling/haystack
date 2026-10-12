// The only way the Worker builds HTML. See "Untrusted content" in
// plans/haystack-v1-implementation-plan.md: captured titles, descriptions, and URLs come from
// pages anyone can write, so every interpolated value is escaped unless it is already SafeHtml.

/** HTML that is already escaped: the result of `html`, never a raw string. */
export class SafeHtml {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  toString(): string {
    return this.#value;
  }
}

type HtmlValue = SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in element content and in quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (value instanceof SafeHtml) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(render).join("");
  }
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value. Nested `html` results and arrays of
 * them are inserted as they are; `null`, `undefined`, and `false` render as nothing. Attribute
 * values must be quoted in the template, as in `<a href="${url}">`.
 */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return new SafeHtml(out);
}
