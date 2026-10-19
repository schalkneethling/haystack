// A local https server that stands in for the pages the address form looks up (#105), for the
// integration, browser and VoiceOver tests. Tests make no requests to the internet, so every page
// the Worker fetches comes from here.
//
// Why https, and how the Worker's fetch trusts it: the address must be an https:// link, because
// Haystack saves only https pages, and production validation is not loosened for tests. Wrangler's
// test harness sends every outbound fetch from the Worker through `globalThis.fetch` in the Node
// process that started the harness (the `outboundService` it sets in wrangler-dist/cli.js). So the
// fetch is made by Node, and Node trusts the fixture's self-signed certificate, which this module
// adds with `tls.setDefaultCACertificates`, for this process only. The certificate is made in
// memory when the first fixture starts (test-certificate.ts), and is valid for a day.
//
// Because Node makes the request, three things differ from production, and the tests do not rely
// on them: Node follows redirects itself, so the Worker sees the final response under the first
// URL; Node keeps reading a body after the Worker has stopped, so a test cannot tell from here
// when the Worker stopped reading; and Node adds headers of its own, such as `accept-language`.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { makeTestCertificate, type TestCertificate } from "./test-certificate.ts";

/** A request the fixture received, as the page's server saw it. */
export interface FixtureRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

export type FixtureHandler = (request: IncomingMessage, response: ServerResponse) => void;

export interface PageFixture {
  /** The fixture's origin, an https:// address on 127.0.0.1. */
  readonly origin: string;
  /** The address of a path on the fixture. */
  url(path: string): string;
  /** Every request received since the fixture started or was last reset, in order. */
  readonly requests: readonly FixtureRequest[];
  /** Serves `path` with a handler. A path with no handler answers 404. */
  route(path: string, handler: FixtureHandler): void;
  /** Serves `path` as an HTML page. */
  page(path: string, html: string): void;
  /** Forgets the routes and the requests. */
  reset(): void;
  /** Stops the server, closing any response still open. */
  close(): Promise<void>;
}

let certificate: TestCertificate | undefined;

// The fixture's certificate, made once per process and added to the certificates this process's
// TLS clients trust, which the harness's fetches use.
function trustedCertificate(): TestCertificate {
  if (certificate === undefined) {
    certificate = makeTestCertificate();
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), certificate.cert]);
  }
  return certificate;
}

/** Starts a page fixture on 127.0.0.1, on a free port. */
export async function startPageFixture(): Promise<PageFixture> {
  const routes = new Map<string, FixtureHandler>();
  const requests: FixtureRequest[] = [];
  const server: Server = createServer(trustedCertificate(), (request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, headers: request.headers });
    const handler = routes.get(path);
    if (handler === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    requests,
    route: (path, handler) => {
      routes.set(path, handler);
    },
    page: (path, html) => {
      routes.set(path, (_, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
      });
    },
    reset: () => {
      routes.clear();
      requests.length = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
