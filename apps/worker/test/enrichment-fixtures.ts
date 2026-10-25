// Every service the enrichment module (#126) calls, for its tests: Jev (jev-fixture.ts), GitHub
// (github-fixture.ts), and Anthropic and AI Gateway (anthropic-fixture.ts). One module asks all
// of them for the same bookmark, and only one MSW server can patch the process's `fetch` at a
// time, so this serves the three fixtures' own handlers from one server (mock-server.ts). Each
// fixture keeps its own queue, its own records and its own checks, such as the gateway's
// `cf-aig-collect-log-payload` header, so a test here answers each service as that service's own
// tests do.
//
// The Jev and Anthropic fixtures' handlers come before GitHub's, because GitHub's answers every
// path on its loopback origin, which the other two share. The tests here use the `.test`
// origins, so each request reaches its own service's handler either way.
import { type AnthropicFixture, anthropicFixtureParts } from "./anthropic-fixture.ts";
import { type GitHubFixture, gitHubFixtureParts } from "./github-fixture.ts";
import { type JevFixture, jevFixtureParts } from "./jev-fixture.ts";
import { serveFixtures } from "./mock-server.ts";

export interface EnrichmentFixtures {
  readonly jev: Omit<JevFixture, "close">;
  readonly github: Omit<GitHubFixture, "close">;
  // Anthropic and AI Gateway, which share one queue.
  readonly llm: Omit<AnthropicFixture, "close">;
  /**
   * Requests no test planned for: those each fixture recorded, and those to an address no
   * fixture answers.
   */
  readonly unplanned: readonly string[];
  /** Forgets every fixture's queued resolvers and requests. */
  reset(): void;
  /** Stops answering, and restores `globalThis.fetch`. */
  close(): void;
}

/**
 * Starts answering every enrichment service's requests in this process. Only one may run at a
 * time, and no other fixture with it, because it patches the process's `fetch`.
 */
export function startEnrichmentFixtures(): EnrichmentFixtures {
  const jev = jevFixtureParts();
  const llm = anthropicFixtureParts();
  const github = gitHubFixtureParts();
  // Requests to an address none of the three answers.
  const elsewhere: string[] = [];
  const close = serveFixtures([...jev.handlers, ...llm.handlers, ...github.handlers], elsewhere);
  return {
    jev,
    github,
    llm,
    get unplanned() {
      return [...jev.unplanned, ...github.unplanned, ...llm.unplanned, ...elsewhere];
    },
    reset: () => {
      jev.reset();
      github.reset();
      llm.reset();
      elsewhere.length = 0;
    },
    close,
  };
}
