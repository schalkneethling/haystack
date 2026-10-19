// The pages the address form looks up (#105), for the integration, browser and VoiceOver tests.
// Tests make no requests to the internet, so every page the Worker fetches is answered here, by
// Mock Service Worker (MSW) in the test's own process.
//
// Why that works: Wrangler's test harness sends every outbound fetch from the Worker through
// `globalThis.fetch` in the Node process that started the harness (the `outboundService` it sets
// in wrangler-dist/cli.js, which looks `globalThis.fetch` up on each call). MSW's `setupServer`
// patches that function, so it answers the Worker's requests with the pages a test registers.
// Their addresses are ordinary https:// addresses under the reserved `.test` domain, so the
// Worker's validation is the production validation, and no name is ever looked up.
//
// Any other request is one no test planned for. MSW fails it (`onUnhandledFrame: "error"`), so
// the Worker falls back to the address alone, and this module records its address in
// `unplanned`, which the tests check, so the test fails rather than passing on the fallback. The
// harness's own requests, such as the integration tests' `server.fetch`, do not go through the
// functions MSW patches, so they are not affected. Playwright's request API does, when a browser
// test calls the Worker from Node, so the browser tests' fixtures let exactly the Worker's own
// origin through, with `allow`.
//
// Because Node makes the request, four things differ from production, and the tests do not rely
// on them (the plan's "Testing strategy" lists them too): Node follows redirects itself, so the
// Worker sees the final response under the first address; Node keeps reading a body after the
// Worker has cancelled it, so a test cannot see the cancellation; a request Node cannot make
// reaches the Worker as a 500 response rather than an error; and Node adds headers of its own,
// such as `accept-language`.
import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";

/** The address the test pages are served at, unless a test names another `.test` address. */
export const PAGES_ORIGIN = "https://pages.test";

/** A request the fixture answered, as the page's server would see it. */
export interface FixtureRequest {
  /** The whole address. */
  readonly url: string;
  /** The path and query. */
  readonly path: string;
  readonly headers: Headers;
}

export type FixtureResolver = (request: Request) => Response | Promise<Response>;

export interface PageFixture {
  /** The address of a path, on PAGES_ORIGIN or on another `.test` origin. */
  url(path: string, origin?: string): string;
  /** Every request answered since the fixture started or was last reset, in order. */
  readonly requests: readonly FixtureRequest[];
  /** Addresses requested that are not on a `.test` origin, which no test planned for. */
  readonly unplanned: readonly string[];
  /** Answers an address with a resolver. A `.test` address with none answers 404. */
  route(url: string, resolver: FixtureResolver): void;
  /** Serves an address as an HTML page. */
  page(url: string, html: string): void;
  /** Lets every request to `origin` through untouched: the Worker's own address. */
  allow(origin: string): void;
  /** Forgets the routes and the requests. */
  reset(): void;
  /** Stops answering, and restores `globalThis.fetch`. */
  close(): void;
}

// Any https address on a host under `.test`.
const TEST_ADDRESS = /^https:\/\/[^/?#]+\.test(?::\d+)?\//;

// A path is on PAGES_ORIGIN, and a whole address stays as it is. Both are serialized, so a key is
// found whichever way it was written, as the URL parser would read it.
function key(url: string): string {
  return new URL(url, PAGES_ORIGIN).href;
}

/**
 * Starts answering the Worker's requests in this process. Start it before the harness, and only
 * one at a time, because it patches the process's `fetch`.
 */
export function startPageFixture(): PageFixture {
  const routes = new Map<string, FixtureResolver>();
  const requests: FixtureRequest[] = [];
  const unplanned: string[] = [];
  const mock = setupServer(
    http.all(TEST_ADDRESS, ({ request }) => {
      const url = new URL(request.url);
      requests.push({ url: url.href, path: url.pathname + url.search, headers: request.headers });
      const resolver = routes.get(url.href);
      return resolver === undefined
        ? new HttpResponse("Not found", { status: 404, headers: { "content-type": "text/plain" } })
        : resolver(request);
    }),
  );
  mock.events.on("request:unhandled", ({ request }) => {
    unplanned.push(request.url);
  });
  mock.listen({ onUnhandledFrame: "error" });
  return {
    url: (path, origin = PAGES_ORIGIN) => new URL(path, origin).href,
    requests,
    unplanned,
    route: (url, resolver) => {
      routes.set(key(url), resolver);
    },
    page: (url, html) => {
      routes.set(key(url), () =>
        HttpResponse.html(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
    },
    allow: (origin) => {
      const escaped = new URL(origin).origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      mock.use(http.all(new RegExp(`^${escaped}/`), () => passthrough()));
    },
    reset: () => {
      routes.clear();
      requests.length = 0;
      unplanned.length = 0;
    },
    close: () => {
      mock.close();
    },
  };
}
