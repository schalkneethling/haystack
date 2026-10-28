// GitHub's REST API for the GitHub client's tests (#123), in the style of jev-fixture.ts. Tests
// make no requests to the internet: Mock Service Worker (MSW) patches `globalThis.fetch` in the
// test's own process, and answers the client's requests at GITHUB_ORIGIN, under the reserved
// `.test` domain, so no name is ever looked up, and at GITHUB_LOOPBACK_ORIGIN, without a socket.
//
// A test queues one resolver for each request it expects, in order. Any other request is one no
// test planned for: a request beyond the queue, or to any other address, such as a redirect's
// target. The fixture records its address in `unplanned`, which the tests check, and MSW fails it
// (`onUnhandledFrame: "error"`), so it never reaches the network.
import { http, HttpResponse, type JsonBodyType } from "msw";
import { escapeRegExp } from "./escape-regexp.ts";
import { type FixtureParts, serveFixtures } from "./mock-server.ts";

/** The address the tests configure as GITHUB_API_BASE_URL. */
export const GITHUB_ORIGIN = "https://api.github.test";

/** A request the fixture answered, as GitHub would see it. */
export interface GitHubRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

export type GitHubResolver = (request: Request) => Response | Promise<Response>;

export interface GitHubFixture {
  /** Every request the fixture answered since it started or was last reset, in order. */
  readonly requests: readonly GitHubRequest[];
  /** Requests no test planned for. */
  readonly unplanned: readonly string[];
  /** Answers the next requests, one resolver each, in order. */
  respond(...resolvers: GitHubResolver[]): void;
  /** Forgets the queued resolvers and the requests. */
  reset(): void;
  /** Stops answering, and restores `globalThis.fetch`. */
  close(): void;
}

/** A 200 response with this body, as JSON. */
export function json(body: JsonBodyType): GitHubResolver {
  return () => HttpResponse.json(body);
}

/** A 200 response with this README, as the raw media type returns it. */
export function readme(markdown: string): GitHubResolver {
  return () =>
    new HttpResponse(markdown, {
      headers: { "content-type": "application/vnd.github.raw+json; charset=utf-8" },
    });
}

/**
 * A README with the syntax that READMEs use: HTML, a comment, badges, headings, an alert,
 * emphasis, lists, code fences, a table, a rule, links of each kind, escapes, character
 * references and footnotes. readme-excerpt.test.ts shows the text a reader would see.
 */
export const SAMPLE_README = [
  '<p align="center">',
  '  <a href="https://vitest.test"><img src="logo.svg" alt="Vitest logo" height="120"></a>',
  "</p>",
  "<!-- Badges are generated. Don't edit them by hand. -->",
  "[![npm](https://img.shields.test/npm/v/vitest)](https://npmjs.test/vitest) ![CI][ci-badge]",
  "",
  "# Vitest",
  "",
  "> [!NOTE]",
  "> Next generation testing framework **powered by** [Vite](https://vite.test).",
  "",
  "Setext heading",
  "==============",
  "",
  "## Features ##",
  "",
  "- *Fast* by default, with __native__ ESM",
  "* ~~Slow~~ watch mode, like `jest --watch`",
  "1. Works with snake_case_names and 2 * 3 = 6",
  "- [x] Task done",
  "",
  "```ts",
  "import { test } from 'vitest'; // **not prose**",
  "```",
  "",
  "~~~",
  "# not a heading",
  "~~~",
  "",
  "| Feature | Status |",
  "| :------ | -----: |",
  "| Watch   | Done   |",
  "",
  "***",
  "",
  "See the [guide][guide] and <https://vitest.test/docs>.[^1]",
  "Escaped \\*stars\\* stay, and so do &lt;angle brackets&gt; &amp; entities.",
  "<details><summary>More</summary>Hidden <b>details</b></details>",
  "",
  "[guide]: https://vitest.test/guide",
  "[ci-badge]: https://ci.test/badge.svg",
  "[^1]: A footnote.",
].join("\n");

/** A response with this status and a JSON error body, as GitHub sends. */
export function status(code: number, headers: Record<string, string> = {}): GitHubResolver {
  return () =>
    HttpResponse.json(
      { message: "fixture error", documentation_url: "https://docs.github.test/rest" },
      { status: code, headers },
    );
}

/** A request that fails without a response, as a refused connection does. */
export const networkError: GitHubResolver = () => HttpResponse.error();

/**
 * A plain-http address on this machine, as an integration test's local server would have, which
 * the client accepts as GITHUB_API_BASE_URL. MSW answers it in this process like GITHUB_ORIGIN, so
 * no socket is opened.
 */
export const GITHUB_LOOPBACK_ORIGIN = "http://127.0.0.1:8788";

// Any address on GITHUB_ORIGIN or GITHUB_LOOPBACK_ORIGIN.
const GITHUB_ADDRESS = new RegExp(
  `^(?:${escapeRegExp(GITHUB_ORIGIN)}|${escapeRegExp(GITHUB_LOOPBACK_ORIGIN)})/`,
);

/**
 * The fixture's handlers and records, without a server, so enrichment-fixtures.ts can serve them
 * together with the other services' fixtures.
 */
export function gitHubFixtureParts(): FixtureParts<GitHubFixture> {
  const queue: GitHubResolver[] = [];
  const requests: GitHubRequest[] = [];
  const unplanned: string[] = [];
  return {
    handlers: [
      http.all(GITHUB_ADDRESS, ({ request }) => {
        requests.push({ url: request.url, method: request.method, headers: request.headers });
        const resolver = queue.shift();
        if (resolver === undefined) {
          unplanned.push(request.url);
          return HttpResponse.error();
        }
        return resolver(request);
      }),
    ],
    requests,
    unplanned,
    respond: (...resolvers) => {
      queue.push(...resolvers);
    },
    reset: () => {
      queue.length = 0;
      requests.length = 0;
      unplanned.length = 0;
    },
  };
}

/**
 * Starts answering the client's requests in this process. Only one may run at a time, because it
 * patches the process's `fetch`.
 */
export function startGitHubFixture(): GitHubFixture {
  const parts = gitHubFixtureParts();
  return { ...parts, close: serveFixtures(parts.handlers, parts.unplanned) };
}
