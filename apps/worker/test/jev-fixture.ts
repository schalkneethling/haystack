// TypeSafe's API for the Jev client's tests (#122), in the style of page-fixture.ts. Tests make
// no requests to the internet: Mock Service Worker (MSW) patches `globalThis.fetch` in the test's
// own process, and answers the client's requests at JEV_ORIGIN, under the reserved `.test`
// domain, so no name is ever looked up, and at JEV_LOOPBACK_ORIGIN, without a socket.
//
// A test queues one resolver for each request it expects, in order. Any other request is one no
// test planned for: a request beyond the queue, to another path, or to any other address, such
// as a redirect's target. The fixture records its address in `unplanned`, which the tests check,
// and MSW fails it (`onUnhandledFrame: "error"`), so it never reaches the network.
import { http, HttpResponse, type JsonBodyType } from "msw";
import { type FixtureParts, serveFixtures } from "./mock-server.ts";

/** The address the tests configure as JEV_BASE_URL. */
export const JEV_ORIGIN = "https://jev.test";

/** The endpoint the client posts every question to. */
export const SYSTEM_ONE_URL = `${JEV_ORIGIN}/v1/systemone`;

/**
 * A plain-http address on this machine, as an integration test's local server would have, which
 * the client accepts as JEV_BASE_URL. MSW answers it in this process like JEV_ORIGIN, so no
 * socket is opened.
 */
export const JEV_LOOPBACK_ORIGIN = "http://127.0.0.1:8788";

/** A request the fixture answered, as TypeSafe would see it. */
export interface JevRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The body as sent. */
  readonly body: string;
}

export type JevResolver = (request: Request) => Response | Promise<Response>;

export interface JevFixture {
  /** Every request to the endpoint since the fixture started or was last reset, in order. */
  readonly requests: readonly JevRequest[];
  /** Requests no test planned for. */
  readonly unplanned: readonly string[];
  /** Answers the next requests to the endpoint, one resolver each, in order. */
  respond(...resolvers: JevResolver[]): void;
  /** Forgets the queued resolvers and the requests. */
  reset(): void;
  /** Stops answering, and restores `globalThis.fetch`. */
  close(): void;
}

/** A 200 response with this body, as JSON. */
export function answer(body: JsonBodyType): JevResolver {
  return () => HttpResponse.json(body);
}

/** A response with this status and a JSON error body. */
export function status(code: number, headers: Record<string, string> = {}): JevResolver {
  return () => HttpResponse.json({ detail: "fixture error" }, { status: code, headers });
}

/** A request that fails without a response, as a refused connection does. */
export const networkError: JevResolver = () => HttpResponse.error();

/**
 * The fixture's handlers and records, without a server, so enrichment-fixtures.ts can serve them
 * together with the other services' fixtures.
 */
export function jevFixtureParts(): FixtureParts<JevFixture> {
  const queue: JevResolver[] = [];
  const requests: JevRequest[] = [];
  const unplanned: string[] = [];
  const answerNext = async ({ request }: { request: Request }) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
    });
    const resolver = queue.shift();
    if (resolver === undefined) {
      unplanned.push(request.url);
      return HttpResponse.error();
    }
    return resolver(request);
  };
  return {
    handlers: [
      http.post(SYSTEM_ONE_URL, answerNext),
      http.post(`${JEV_LOOPBACK_ORIGIN}/v1/systemone`, answerNext),
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
export function startJevFixture(): JevFixture {
  const parts = jevFixtureParts();
  return { ...parts, close: serveFixtures(parts.handlers, parts.unplanned) };
}
