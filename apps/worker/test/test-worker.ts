// The Worker under Wrangler's test harness, for every test that starts one: the integration tests
// here and the browser tests (e2e/fixtures.ts). See "Testing strategy" in
// plans/haystack-v1-implementation-plan.md.
//
// The harness binds more than the options a test gives it. wrangler.jsonc lists the Worker's
// secrets under `secrets.required`, and for those the harness also reads `.dev.vars`, `.env`
// files and the environment of the process that started it (`getVarsForDev` in
// wrangler-dist/cli.js of Wrangler 4.151.0, which passes `includeProcessEnv: true` whenever the
// config has `secrets`). So a shell that holds a real key, such as TYPESAFE_API_KEY, would give it
// to the Worker under test, and the Worker would call the real service at the production address
// in wrangler.jsonc, paying for the request and depending on its answer. Every Worker here is
// therefore started with two overrides, which the harness applies over whatever it read
// (`WorkerInput`'s `secrets` and `vars`, "test-only" values that override the config's and the
// files'):
// - Every required secret is empty, unless the test gives a test value of its own. An empty key
//   is a configuration error, which each client finds before it sends anything.
// - Every address the Worker fetches from an outside service is under the reserved `.test`
//   domain, unless the test gives another: each enrichment service's base URL is its fixture's,
//   and so are Google's token endpoint and keys, which sign-in.test.ts serves. So a request that
//   still goes out reaches a fixture, or fails as one no test planned for, and never reaches the
//   internet. Google's issuer and authorization endpoint stay as wrangler.jsonc has them,
//   because the Worker never fetches them: the issuer is compared, and the browser is sent to the
//   authorization endpoint, which no test follows.
import { readFileSync } from "node:fs";
import { createTestHarness } from "wrangler";
import { ANTHROPIC_ORIGIN, GATEWAY_ORIGIN } from "./anthropic-fixture.ts";
import { GITHUB_ORIGIN } from "./github-fixture.ts";
import { JEV_ORIGIN } from "./jev-fixture.ts";

const CONFIG_URL = new URL("../wrangler.jsonc", import.meta.url);

/** Every address the Worker fetches from an outside service, under `.test`. */
export const SERVICE_ADDRESSES = {
  JEV_BASE_URL: JEV_ORIGIN,
  GITHUB_API_BASE_URL: GITHUB_ORIGIN,
  ANTHROPIC_BASE_URL: ANTHROPIC_ORIGIN,
  AI_GATEWAY_BASE_URL: GATEWAY_ORIGIN,
  // No test serves these at this address. sign-in.test.ts gives its own fixture's.
  GOOGLE_TOKEN_ENDPOINT: "https://oauth2.google.test/token",
  GOOGLE_JWKS_URI: "https://www.google.test/oauth2/v3/certs",
} as const;

/**
 * The names in wrangler.jsonc's `secrets.required`, so a secret added there is emptied here too.
 * The file is JSONC, which nothing installed parses but Wrangler, whose reader isn't part of its
 * typed API, so the names are read from the one place they appear: the `"required"` array inside
 * `"secrets"`, which holds only quoted names. Throws when it can't find them, rather than start a
 * Worker that might hold a real secret.
 */
function requiredSecrets(): string[] {
  const config = readFileSync(CONFIG_URL, "utf8");
  const list = /"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1];
  const names = [...(list ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map(([, name]) => name);
  if (names.length === 0) {
    throw new Error(`No secrets.required found in ${CONFIG_URL.pathname}`);
  }
  return names.filter((name): name is string => name !== undefined);
}

const EMPTY_SECRETS: Record<string, string> = Object.fromEntries(
  requiredSecrets().map((name) => [name, ""]),
);

/** The harness createTestWorker returns. */
export type TestWorker = ReturnType<typeof createTestHarness>;

export interface TestWorkerOptions {
  /** `vars` over wrangler.jsonc's and SERVICE_ADDRESSES. */
  readonly vars?: Record<string, string>;
  /** Test values for secrets, over the empty ones. */
  readonly secrets?: Record<string, string>;
}

/**
 * A test harness for the Worker in wrangler.jsonc, with every required secret empty and every
 * outside service at its fixture's address, unless `options` says otherwise.
 */
export function createTestWorker({ vars = {}, secrets = {} }: TestWorkerOptions = {}): TestWorker {
  return createTestHarness({
    workers: [
      {
        configPath: CONFIG_URL,
        vars: { ...SERVICE_ADDRESSES, ...vars },
        secrets: { ...EMPTY_SECRETS, ...secrets },
      },
    ],
  });
}
