import { describe, expect, it } from "vite-plus/test";
import { describeUrlForJudgment, type UrlDescription } from "../src/index.ts";

function describeUrl(url: string, title?: string, flag = false): UrlDescription {
  return describeUrlForJudgment(new URL(url), title, flag);
}

// The grammar from the plan, written out here so that a change to it must change this test.
const PLACEHOLDER = /^<(?:empty|(?:digits|word|hex|random):[1-9][0-9]*)>$/;
// A kept path segment, name or anchor has only these characters.
const KEPT = /^[A-Za-z0-9._ -]+$/;

// Every query and fragment value and every credential in the URL, read by a parser written for
// this test rather than the one under test. Fragment values include a hash route's query.
function valuesIn(url: URL): string[] {
  const pairs = [...url.search.slice(1).split("&"), ...url.hash.slice(1).split(/[?&]/)];
  const values = pairs.flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator === -1 ? [] : [pair.slice(separator + 1)];
  });
  return [...values, url.username, url.password];
}

// A value as written and each way it can be decoded, as a path (`+` kept) or as a form (`+` is a
// space).
function forms(raw: string): string[] {
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  return [raw, decode(raw), decode(raw.replaceAll("+", " "))];
}

interface Fixture {
  name: string;
  url: string;
  title: string;
  expected: UrlDescription;
  // The path segments that must be masked, as written in the URL.
  randomSegments: string[];
}

const fixtures: Fixture[] = [
  {
    name: "a Google Docs share",
    url: "https://docs.google.com/document/d/1Xk9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCd/edit?usp=sharing",
    title: "Q3 planning (draft) - Google Docs",
    expected: {
      scheme: "https",
      host: "docs.google.com",
      path: "/document/d/<random:44>/edit",
      query: [{ name: "usp", value: "<word:7>" }],
      title: "Q3 planning (draft) - Google Docs",
    },
    randomSegments: ["1Xk9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCd"],
  },
  {
    name: "a Dropbox link",
    url: "https://www.dropbox.com/scl/fi/k3j9x2m1q8w7e6r5t4y3u/Quarterly%20Report.pdf?rlkey=a1b2c3d4e5f6g7h8i9j0klmno&dl=0",
    title: "Quarterly Report.pdf",
    expected: {
      scheme: "https",
      host: "www.dropbox.com",
      path: "/scl/fi/<random:21>/Quarterly Report.pdf",
      query: [
        { name: "rlkey", value: "<random:25>" },
        { name: "dl", value: "<digits:1>" },
      ],
      title: "Quarterly Report.pdf",
    },
    randomSegments: ["k3j9x2m1q8w7e6r5t4y3u"],
  },
  {
    name: "a pre-signed S3 URL",
    url: "https://haystack-exports.s3.eu-west-1.amazonaws.com/reports/q3-summary.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261021%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261021T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host%3Brange&X-Amz-Signature=9b2fd41c7e8a03b6f5d2c9e1a4b7f0c39b2fd41c7e8a03b6f5d2c9e1a4b7f0c3",
    title: "q3-summary.pdf",
    expected: {
      scheme: "https",
      host: "haystack-exports.s3.eu-west-1.amazonaws.com",
      path: "/reports/q3-summary.pdf",
      query: [
        { name: "X-Amz-Algorithm", value: "<word:16>" },
        { name: "X-Amz-Credential", value: "<random:55>" },
        { name: "X-Amz-Date", value: "<random:16>" },
        { name: "X-Amz-Expires", value: "<digits:4>" },
        { name: "X-Amz-SignedHeaders", value: "<random:10>" },
        { name: "X-Amz-Signature", value: "<hex:64>" },
      ],
      title: "q3-summary.pdf",
    },
    randomSegments: [],
  },
  {
    name: "a Notion share",
    url: "https://www.notion.so/acme/Team-Roadmap-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?pvs=4",
    title: "Team Roadmap",
    expected: {
      scheme: "https",
      host: "www.notion.so",
      path: "/acme/<random:45>",
      query: [{ name: "pvs", value: "<digits:1>" }],
      title: "Team Roadmap",
    },
    randomSegments: ["Team-Roadmap-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6"],
  },
  {
    name: "a magic sign-in link",
    url: "https://app.example.com/auth/magic-link?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk&email=schalk%40example.com&redirect_to=%2Fsaved",
    title: "Sign in to Example",
    expected: {
      scheme: "https",
      host: "app.example.com",
      path: "/auth/magic-link",
      query: [
        { name: "token", value: "<random:80>" },
        { name: "email", value: "<random:18>" },
        { name: "redirect_to", value: "<random:6>" },
      ],
      title: "Sign in to Example",
    },
    randomSegments: [],
  },
  {
    name: "an invitation link",
    url: "https://join.slack.com/t/acme-team/shared_invite/zt-2abc3def4-XyZ_1aBcDeFgHiJkLmNoPq",
    title: "Join Acme Team on Slack",
    expected: {
      scheme: "https",
      host: "join.slack.com",
      path: "/t/acme-team/shared_invite/<random:35>",
      title: "Join Acme Team on Slack",
    },
    randomSegments: ["zt-2abc3def4-XyZ_1aBcDeFgHiJkLmNoPq"],
  },
  {
    name: "a password reset link",
    url: "https://accounts.example.com/reset-password/7f3c9a2e-1b4d-4e8a-9c6f-2d1e0b3a5c7f?expires=1761091200&signature=9b2fd41c7e8a03b6f5d2c9e1a4b7f0c3",
    title: "Choose a new password",
    expected: {
      scheme: "https",
      host: "accounts.example.com",
      path: "/reset-password/<random:36>",
      query: [
        { name: "expires", value: "<digits:10>" },
        { name: "signature", value: "<hex:32>" },
      ],
      title: "Choose a new password",
    },
    randomSegments: ["7f3c9a2e-1b4d-4e8a-9c6f-2d1e0b3a5c7f"],
  },
  {
    name: "a hash route that carries a token",
    url: "https://app.example.com/#/auth/callback?access_token=ya29.a0AfB_byC1d2E3f4G5h6&state=af0ifjsldkj7Qw",
    title: "Signing you in",
    expected: {
      scheme: "https",
      host: "app.example.com",
      path: "/",
      fragment: {
        route: "/auth/callback",
        parameters: [
          { name: "access_token", value: "<random:25>" },
          { name: "state", value: "<random:14>" },
        ],
      },
      title: "Signing you in",
    },
    randomSegments: [],
  },
  {
    name: "a fragment of parameters (the OAuth implicit flow)",
    url: "https://app.example.com/oauth/callback#id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl&token_type=Bearer&expires_in=3599",
    title: "Signing you in",
    expected: {
      scheme: "https",
      host: "app.example.com",
      path: "/oauth/callback",
      fragment: {
        parameters: [
          { name: "id_token", value: "<random:50>" },
          { name: "token_type", value: "<word:6>" },
          { name: "expires_in", value: "<digits:4>" },
        ],
      },
      title: "Signing you in",
    },
    randomSegments: [],
  },
  {
    name: "percent-encoded values",
    url: "https://example.com/share/Projekt%20Pl%C3%A4ne?note=caf%C3%A9%20secret%2Fvalue&redirect=https%3A%2F%2Fexample.org%2Fcb%3Ftoken%3Dnested-token-7Hq2&q=%E2%9C%93+done",
    title: "Shared plans",
    expected: {
      scheme: "https",
      host: "example.com",
      path: "/share/<random:13>",
      query: [
        { name: "note", value: "<random:17>" },
        { name: "redirect", value: "<random:46>" },
        { name: "q", value: "<random:6>" },
      ],
      title: "Shared plans",
    },
    randomSegments: ["Projekt%20Pl%C3%A4ne", "Projekt Pläne", "nested-token-7Hq2"],
  },
  {
    name: "an internationalized host",
    url: "https://bücher.example:8443/kategorie/romane/9783161484100?ref=newsletter-xK9q2",
    title: "Romane – Bücher",
    expected: {
      scheme: "https",
      host: "xn--bcher-kva.example:8443",
      path: "/kategorie/romane/<digits:13>",
      query: [{ name: "ref", value: "<random:16>" }],
      title: "Romane – Bücher",
    },
    randomSegments: ["9783161484100"],
  },
  {
    name: "credentials in the URL",
    url: "https://alice:hunter2-Secret@intranet.example.com/wiki/Home",
    title: "Home - Intranet",
    expected: {
      scheme: "https",
      host: "intranet.example.com",
      path: "/wiki/Home",
      title: "Home - Intranet",
    },
    randomSegments: [],
  },
];

// The secrets of a fixture in every form, longer than two characters. Shorter ones (`dl=0`)
// would match the digits of a placeholder's length, so the placeholder check covers them.
function secretsOf(fixture: Fixture): string[] {
  const raw = [...valuesIn(new URL(fixture.url)), ...fixture.randomSegments];
  return [...new Set(raw.flatMap(forms))].filter((secret) => secret.length > 2);
}

// The path, route, names and values of a description, each of which must be kept text or a
// placeholder.
function partsOf(description: UrlDescription): string[] {
  const parameters = [...(description.query ?? []), ...(description.fragment?.parameters ?? [])];
  const route = description.fragment?.route ?? "";
  return [
    ...description.path.split("/"),
    ...route.replace(/^!/, "").split("/"),
    ...(description.fragment?.anchor === undefined ? [] : [description.fragment.anchor]),
    ...parameters.map(({ name }) => name),
  ].filter((part) => part !== "");
}

describe("describeUrlForJudgment", () => {
  describe.each(fixtures)("for $name", (fixture) => {
    it("describes the URL's shape", () => {
      expect(describeUrl(fixture.url, fixture.title)).toEqual(fixture.expected);
    });

    it("leaves out every value, credential and random-looking segment", () => {
      const serialized = JSON.stringify(describeUrl(fixture.url, fixture.title));
      const secrets = secretsOf(fixture);
      expect(secrets.length).toBeGreaterThan(0);
      for (const secret of secrets) {
        expect(serialized, secret).not.toContain(secret);
      }
    });

    it("gives every value a placeholder, and keeps only word-like text otherwise", () => {
      const description = describeUrl(fixture.url, fixture.title);
      const parameters = [
        ...(description.query ?? []),
        ...(description.fragment?.parameters ?? []),
      ];
      for (const { value } of parameters) {
        expect(value).toMatch(PLACEHOLDER);
      }
      for (const part of partsOf(description)) {
        expect(PLACEHOLDER.test(part) || KEPT.test(part), part).toBe(true);
      }
    });

    it("masks the URL's values in a title that is the address itself", () => {
      // The save form's fallback when a page has no title is the full address.
      const serialized = JSON.stringify(describeUrl(fixture.url, fixture.url));
      for (const secret of secretsOf(fixture)) {
        expect(serialized, secret).not.toContain(secret);
      }
    });

    it("masks the end of a value in a title cut off partway through it", () => {
      for (let length = 1; length <= fixture.url.length; length += 1) {
        const title = describeUrl(fixture.url, fixture.url.slice(0, length)).title ?? "";
        for (const secret of secretsOf(fixture)) {
          expect(title, secret).not.toContain(secret);
          for (let prefix = 4; prefix <= secret.length; prefix += 1) {
            expect(title.endsWith(secret.slice(0, prefix)), `${title} ends with ${secret}`).toBe(
              false,
            );
          }
        }
      }
    });
  });

  // The word-like rule, read through the path: a word-like segment is kept, and any other is
  // replaced by its placeholder.
  it.each([
    ["a word", "document", "/document"],
    ["a short word", "edit", "/edit"],
    ["a hyphenated article slug", "how-to-use-css-grid-in-2026", "/how-to-use-css-grid-in-2026"],
    ["a file name", "index.html", "/index.html"],
    ["an underscored name", "shared_invite", "/shared_invite"],
    ["capitalized words", "Albert_Einstein", "/Albert_Einstein"],
    ["an acronym", "API", "/API"],
    ["camel case", "iPhone", "/iPhone"],
    ["letters and a short number", "es2023", "/es2023"],
    ["a short number and letters", "4k", "/4k"],
    ["a year", "2026", "/2026"],
    ["a date slug", "2026-10-21-release-notes", "/2026-10-21-release-notes"],
    ["a leading separator", ".well-known", "/.well-known"],
    ["an encoded space between words", "Quarterly%20Report.pdf", "/Quarterly Report.pdf"],
    ["an encoded letter", "%64ocument", "/document"],
    // Telling a short lowercase code from words would need a dictionary, so it is kept.
    ["a short lowercase code", "abc-defg-hij", "/abc-defg-hij"],
  ])("keeps %s", (_, segment, path) => {
    expect(describeUrl(`https://example.com/${segment}`).path).toBe(path);
  });

  it.each([
    ["mixed case and digits", "1Xk9aBcD", "/<random:8>"],
    ["letters and digits mixed", "k3j9x2m1", "/<random:8>"],
    ["random lowercase letters", "xkqrzpmt", "/<random:8>"],
    ["a word with five consonants in a row", "strengths", "/<random:9>"],
    ["a number of five digits", "12345", "/<digits:5>"],
    ["more than eight digits split by separators", "2026-10-21-1230", "/<random:15>"],
    ["lowercase hexadecimal", "a3f9c2e1", "/<hex:8>"],
    ["uppercase hexadecimal", "DEADBEEF", "/<hex:8>"],
    ["an acronym of more than four capitals", "README", "/<random:6>"],
    ["random case", "aBcDeF", "/<random:6>"],
    ["a piece longer than 20 characters", "internationalizations", "/<random:21>"],
    ["a UUID", "7f3c9a2e-1b4d-4e8a-9c6f-2d1e0b3a5c7f", "/<random:36>"],
    ["a non-ASCII letter", "caf%C3%A9", "/<random:4>"],
    ["an encoded slash", "a%2Fb", "/<random:3>"],
    ["a plus sign", "a+b", "/<random:3>"],
    ["an invalid escape", "%zz", "/<random:3>"],
  ])("masks %s", (_, segment, path) => {
    expect(describeUrl(`https://example.com/${segment}`).path).toBe(path);
  });

  it("masks a slug longer than 80 characters", () => {
    const slug = Array.from({ length: 17 }, () => "word").join("-");
    expect(slug.length).toBe(84);
    expect(describeUrl(`https://example.com/${slug}`).path).toBe("/<random:84>");
  });

  it("keeps the path's empty segments", () => {
    expect(describeUrl("https://example.com/").path).toBe("/");
    expect(describeUrl("https://example.com/docs/").path).toBe("/docs/");
    expect(describeUrl("https://example.com/a//b").path).toBe("/a//b");
  });

  // The placeholder grammar, read through query values, which are always masked.
  it.each([
    ["an empty value", "", "<empty>"],
    ["digits", "123", "<digits:3>"],
    ["a word", "sharing", "<word:7>"],
    ["words with spaces", "how+to+cook", "<word:11>"],
    ["lowercase hexadecimal", "a3f9c2e1", "<hex:8>"],
    ["uppercase hexadecimal", "DEADBEEF00", "<hex:10>"],
    ["a token", "AbC9xQ", "<random:6>"],
    ["a non-ASCII word, counted in characters", "caf%C3%A9", "<random:4>"],
    ["an emoji, counted as one character", "%F0%9F%94%91", "<random:1>"],
    ["an invalid escape, as written", "a%zz", "<random:4>"],
  ])("gives %s the placeholder %s", (_, value, shape) => {
    expect(describeUrl(`https://example.com/?v=${value}`).query).toEqual([
      { name: "v", value: shape },
    ]);
  });

  it("keeps word-like parameter names, decoded, and masks the rest", () => {
    const longName = "Zx9Kq2Lm8Np4Rt6Vw3Yb5";
    expect(
      describeUrl(`https://example.com/?utm%5Fsource=a&${longName}=b&=c&caf%C3%A9=d`).query,
    ).toEqual([
      { name: "utm_source", value: "<word:1>" },
      { name: "<random:21>", value: "<word:1>" },
      { name: "<empty>", value: "<word:1>" },
      { name: "<random:4>", value: "<word:1>" },
    ]);
  });

  it("keeps repeated names in order, a name without a value, and no empty pairs", () => {
    expect(describeUrl("https://example.com/?&tag=a&&tag=bb&flag").query).toEqual([
      { name: "tag", value: "<word:1>" },
      { name: "tag", value: "<word:2>" },
      { name: "flag", value: "<empty>" },
    ]);
  });

  it("keeps a name such as __proto__ as data", () => {
    const description = describeUrl("https://example.com/?__proto__=x");
    expect(description.query).toEqual([{ name: "__proto__", value: "<word:1>" }]);
    expect(Object.getPrototypeOf(description)).toBe(Object.prototype);
  });

  it.each([
    [
      "a heading anchor",
      "#probabilistic-check-with-jev",
      { anchor: "probabilistic-check-with-jev" },
    ],
    ["a random anchor", "#Zx9Kq2Lm8Np4Rt6Vw3Yb5", { anchor: "<random:21>" }],
    ["an anchor with an encoded space", "#see%20also", { anchor: "see also" }],
    ["a hash route", "#/docs/intro", { route: "/docs/intro" }],
    ["a hash route with a random segment", "#/doc/1Xk9aBcD", { route: "/doc/<random:8>" }],
    ["a hashbang route", "#!/inbox", { route: "!/inbox" }],
    [
      "a hash route's query",
      "#/callback?code=abc&state=",
      {
        route: "/callback",
        parameters: [
          { name: "code", value: "<word:3>" },
          { name: "state", value: "<empty>" },
        ],
      },
    ],
    [
      "parameters",
      "#access_token=abc&token_type=Bearer",
      {
        parameters: [
          { name: "access_token", value: "<word:3>" },
          { name: "token_type", value: "<word:6>" },
        ],
      },
    ],
    [
      "an anchor and a query",
      "#section?x=1",
      { anchor: "section", parameters: [{ name: "x", value: "<digits:1>" }] },
    ],
  ])("describes %s in the fragment", (_, fragment, expected) => {
    expect(describeUrl(`https://example.com/page${fragment}`).fragment).toEqual(expected);
  });

  it.each(["https://example.com/page", "https://example.com/page#", "https://example.com/page#?"])(
    "leaves out a fragment that holds nothing (%s)",
    (url) => {
      expect("fragment" in describeUrl(url)).toBe(false);
    },
  );

  it("leaves out an empty query", () => {
    expect("query" in describeUrl("https://example.com/page?")).toBe(false);
    expect("query" in describeUrl("https://example.com/page?&&")).toBe(false);
  });

  it("keeps the scheme, the host and a port", () => {
    expect(describeUrl("http://Example.COM:8080/a")).toEqual({
      scheme: "http",
      host: "example.com:8080",
      path: "/a",
    });
  });

  it("includes the flag only when it is set", () => {
    const url = "https://docs.example/s/k9Xq2";
    expect(describeUrl(url, "Shared file", true).declares_sensitive_canonical).toBe(true);
    expect("declares_sensitive_canonical" in describeUrl(url, "Shared file", false)).toBe(false);
    expect(JSON.stringify(describeUrl(url, "Shared file", false))).not.toContain(
      "declares_sensitive_canonical",
    );
  });

  it("includes the title as it is when it holds nothing from the URL", () => {
    expect(describeUrl("https://example.com/a", "Release notes (draft)").title).toBe(
      "Release notes (draft)",
    );
  });

  it.each([undefined, ""])("leaves out an absent title (%j)", (title) => {
    expect("title" in describeUrl("https://example.com/a", title)).toBe(false);
  });

  it("masks the URL's values and random segments where the title has them", () => {
    expect(
      describeUrl(
        "https://example.com/files/AbC9xQ7z?token=Zx9Kq2Lm8Np4&usp=sharing",
        "File AbC9xQ7z for token Zx9Kq2Lm8Np4, sharing on",
      ).title,
    ).toBe("File <random:8> for token <random:12>, <word:7> on");
  });

  it("masks credentials where the title has them", () => {
    expect(describeUrl("https://alice:hunter2@example.com/", "alice:hunter2 at work").title).toBe(
      "<word:5>:<word:7> at work",
    );
  });

  it("masks the longest part first, and never a part inside a placeholder", () => {
    // `random` is a masked value, and also a word in the other value's placeholder.
    expect(
      describeUrl("https://example.com/?a=random&b=random-Zx9Kq2Lm", "random-Zx9Kq2Lm random")
        .title,
    ).toBe("<random:15> <word:6>");
  });

  it("leaves masked parts shorter than four characters in the title", () => {
    expect(describeUrl("https://example.com/?page=2", "Page 2 of 10").title).toBe("Page 2 of 10");
  });

  it("does not change the URL it is given", () => {
    const url = new URL("https://user:pass@example.com/a/1Xk9aBcD?x=1#y=2");
    const href = url.href;
    describeUrlForJudgment(url, "Title", true);
    expect(url.href).toBe(href);
  });
});
