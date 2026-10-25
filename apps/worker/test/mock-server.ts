// The Mock Service Worker (MSW) server that the service fixtures answer from: jev-fixture.ts,
// github-fixture.ts and anthropic-fixture.ts. A server patches the process's `fetch`, so only one
// may run at a time. Each fixture therefore builds its handlers and records first, without a
// server, and either starts a server of its own (`startJevFixture` and the others) or shares one
// with the other fixtures (enrichment-fixtures.ts), for a test whose code calls several services.
import type { AnyHandler } from "msw";
import { setupServer } from "msw/node";

/**
 * A fixture's handlers and what it records, before a server answers with them. `unplanned` is
 * the fixture's own list, which its handlers add to and its server adds unmatched requests to.
 */
export type FixtureParts<Fixture> = Omit<Fixture, "close" | "unplanned"> & {
  readonly handlers: readonly AnyHandler[];
  readonly unplanned: string[];
};

/**
 * Starts answering requests in this process with these handlers, in order, and returns the
 * function that stops it and restores `globalThis.fetch`. A request that no handler matches is
 * one no test planned for: its address is added to `unplanned`, and MSW fails it
 * (`onUnhandledFrame: "error"`), so it never reaches the network.
 */
export function serveFixtures(handlers: readonly AnyHandler[], unplanned: string[]): () => void {
  const mock = setupServer(...handlers);
  mock.events.on("request:unhandled", ({ request }) => {
    unplanned.push(request.url);
  });
  mock.listen({ onUnhandledFrame: "error" });
  return () => {
    mock.close();
  };
}
