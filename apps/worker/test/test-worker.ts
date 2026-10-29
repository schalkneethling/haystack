// The Worker under Wrangler's test harness, for every test that starts one: the integration tests
// here and the browser tests (e2e/fixtures.ts). See "Testing strategy" in
// plans/haystack-v1-implementation-plan.md.
//
// The harness binds more than the options a test gives it. wrangler.jsonc lists the Worker's
// secrets under `secrets.required`, and for those the harness also reads `.dev.vars`, `.env`
// files and the environment of the process that started it (`getVarsForDev` in
// wrangler-dist/cli.js of Wrangler 4.151.3, which passes `includeProcessEnv: true` whenever the
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
//
// A Worker without an LLM key, which is every Worker here unless a test gives one, logs one
// `On-save enrichment error:` with a configuration error's code for each bookmark POST /save
// inserts (#133, enrich-on-save.ts). That stays a log line, with no request to any service, only
// because enrichBookmark checks the configuration of every service a bookmark could need before
// its first request.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * JSONC without its comments: every `//` comment to the end of its line, and every `/* … *\/`
 * comment, outside strings. Strings are copied as they are, escapes included, so a `//` in an
 * address such as `"https://api.typesafe.ai"` stays. A comment's line break stays, so the text
 * keeps its lines.
 */
export function withoutJsoncComments(jsonc: string): string {
  let out = "";
  let index = 0;
  while (index < jsonc.length) {
    const char = jsonc[index];
    const next = jsonc[index + 1];
    if (char === '"') {
      // Copy the string, with its escapes, up to and including its closing quote.
      let end = index + 1;
      while (end < jsonc.length && jsonc[end] !== '"') {
        end += jsonc[end] === "\\" ? 2 : 1;
      }
      out += jsonc.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      const end = jsonc.indexOf("\n", index);
      index = end === -1 ? jsonc.length : end;
    } else if (char === "/" && next === "*") {
      const end = jsonc.indexOf("*/", index + 2);
      index = end === -1 ? jsonc.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/**
 * The names in a Wrangler config's `secrets.required`, from its JSONC text. Nothing installed
 * parses JSONC but Wrangler, whose reader isn't part of its typed API, so the comments are taken
 * out and the names are read from the one place they appear: the `"required"` array inside
 * `"secrets"`, which holds only quoted names. Throws when it finds none, rather than start a
 * Worker that might hold a real secret.
 */
export function requiredSecretNames(jsonc: string): string[] {
  const config = withoutJsoncComments(jsonc);
  const list = /"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1];
  const names = [...(list ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/g)]
    .map(([, name]) => name)
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) {
    throw new Error("No secrets.required found in the Wrangler config");
  }
  return names;
}

const EMPTY_SECRETS: Record<string, string> = Object.fromEntries(
  requiredSecretNames(readFileSync(CONFIG_URL, "utf8")).map((name) => [name, ""]),
);

/** The harness createTestWorker returns. */
export type TestWorker = ReturnType<typeof createTestHarness>;

export interface TestWorkerOptions {
  /** `vars` over wrangler.jsonc's and SERVICE_ADDRESSES. */
  readonly vars?: Record<string, string>;
  /** Test values for secrets, over the empty ones. */
  readonly secrets?: Record<string, string>;
  /**
   * Flagship flags by key. Given, FLAGS is bound to the fake Flagship Worker below, which holds
   * exactly these, instead of Miniflare's simulator, which holds none (plan, Q13). Left out, the
   * Worker keeps the simulator, so every flag gives its default.
   */
  readonly flags?: Readonly<Record<string, boolean | number>>;
}

const FAKE_FLAGSHIP = "fake-flagship";

/**
 * A stand-in for the Flagship binding, FLAGS, for the tests that need a flag set. Only an
 * internal method can set a flag in Miniflare's simulator (plan, Q13), so a test Worker that
 * needs one binds FLAGS to this Worker instead, through the harness's `bindingOverrides`.
 * Production code reads FLAGS the same way either way, through the configuration module
 * (src/flags.ts).
 *
 * It answers the two details getters that the module calls (`FlagReader`), over a service
 * binding's RPC, as the simulator does (Q13): a flag it holds gives its value, a value of the
 * wrong type gives the caller's default with TYPE_MISMATCH, and a flag it doesn't hold gives the
 * default with FLAG_NOT_FOUND. The flags are its `FLAG_VALUES` var, a JSON object.
 *
 * Its source is a string, written to a file when a test first starts it, because it imports
 * `cloudflare:workers`, which only the Workers runtime provides: the tests' TypeScript program
 * has Node's types, not the Workers', and knip reports the import as a dependency that no
 * package.json lists. knip.json is Calavera-managed, and Calavera's knip integration has no
 * option for ignoring a dependency.
 */
// WORKAROUND(knip): knip reads cloudflare:workers as the package "cloudflare", so the fake Flagship Worker's source lives in a string rather than a checked-in file | upstream: https://github.com/webpro-nl/knip/issues/2244 | remove-when: knip treats cloudflare: like node:
const FAKE_FLAGSHIP_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";

export default class FakeFlagship extends WorkerEntrypoint {
  details(key, defaultValue, type) {
    const values = this.env.FLAG_VALUES;
    if (!Object.hasOwn(values, key)) {
      return { value: defaultValue, errorCode: "FLAG_NOT_FOUND" };
    }
    return typeof values[key] === type
      ? { value: values[key] }
      : { value: defaultValue, errorCode: "TYPE_MISMATCH" };
  }

  async getBooleanDetails(key, defaultValue) {
    return this.details(key, defaultValue, "boolean");
  }

  async getNumberDetails(key, defaultValue) {
    return this.details(key, defaultValue, "number");
  }

  // A Worker needs a fetch handler. Nothing requests this one.
  async fetch() {
    return new Response("Not found", { status: 404 });
  }
}
`;

/** The fake's entry module, and how to remove it. */
interface FakeFlagshipModule {
  readonly path: string;
  remove(): void;
}

// The fake's entry module, in a directory of its own under the system's temporary directory, so
// harnesses, test files and Playwright workers running in parallel never share one. The harness
// that uses it removes it when it closes. Vitest ends its test workers without the process's
// `exit` event, which left two directories behind for every `vp test` when that was the only
// removal, so `exit` is only the backup, for a process that ends before its harness closes.
function fakeFlagshipModule(): FakeFlagshipModule {
  const directory = mkdtempSync(join(tmpdir(), "haystack-fake-flagship-"));
  const remove = () => {
    rmSync(directory, { recursive: true, force: true });
  };
  process.once("exit", remove);
  const path = join(directory, "index.js");
  writeFileSync(path, FAKE_FLAGSHIP_SOURCE);
  return { path, remove };
}

// The fake runs on the Worker's own compatibility date, read from wrangler.jsonc as the secrets'
// names are, so the two can't drift apart.
function compatibilityDate(jsonc: string): string {
  const date = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(withoutJsoncComments(jsonc))?.[1];
  if (date === undefined) {
    throw new Error("No compatibility_date found in the Wrangler config");
  }
  return date;
}

/**
 * A test harness for the Worker in wrangler.jsonc, with every required secret empty and every
 * outside service at its fixture's address, unless `options` says otherwise.
 */
export function createTestWorker({
  vars = {},
  secrets = {},
  flags,
}: TestWorkerOptions = {}): TestWorker {
  const haystack = {
    configPath: CONFIG_URL,
    vars: { ...SERVICE_ADDRESSES, ...vars },
    secrets: { ...EMPTY_SECRETS, ...secrets },
  };
  if (flags === undefined) {
    return createTestHarness({ workers: [haystack] });
  }
  // The first Worker is the one the harness serves. The fake answers FLAGS over a service
  // binding, which `bindingOverrides` puts in place of the Flagship binding.
  const fake = fakeFlagshipModule();
  const harness = createTestHarness({
    workers: [
      { ...haystack, bindingOverrides: { FLAGS: FAKE_FLAGSHIP } },
      {
        config: {
          name: FAKE_FLAGSHIP,
          main: fake.path,
          compatibility_date: compatibilityDate(readFileSync(CONFIG_URL, "utf8")),
          vars: { FLAG_VALUES: flags },
        },
      },
    ],
  });
  const close = harness.close.bind(harness);
  return Object.assign(harness, {
    async close() {
      try {
        await close();
      } finally {
        fake.remove();
      }
    },
  });
}
