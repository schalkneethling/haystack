// The contract check's command (#203): one live request to each outside API the enrichment
// clients call, with the production configuration, and one line of report for each. See
// "Testing strategy" in plans/haystack-v1-implementation-plan.md for when to run it.
//
// Run it with `vp -C evals run contract`. That runs this directory's tests first, then this file
// under `varlock run`, which resolves the four keys the requests need from apps/worker/.env.schema
// through 1Password and gives them to this process only. Nothing here reads a `.env` file. It is
// never part of `vp test`, `vp run quality` or CI, because CI has no secrets (decision 11).
//
// The configuration is the Worker's own: the `vars` in apps/worker/wrangler.jsonc, read with
// Wrangler's config reader, so the requests use the production addresses and the pinned models.
// The exit status is 1 when any check didn't pass.
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { CONTRACT_CHECKS, type ContractConfig } from "./contract-checks.ts";
import { runContractChecks } from "./contract-report.ts";

const WRANGLER_CONFIG = fileURLToPath(new URL("../apps/worker/wrangler.jsonc", import.meta.url));

// The Worker's configuration, with each secret from this process's environment. A missing value
// is empty, and the client that needs it reports its configuration error without sending
// anything.
function contractConfig(): ContractConfig {
  const { vars } = unstable_readConfig({ config: WRANGLER_CONFIG }, { hideWarnings: true });
  const variable = (name: string): string => {
    const value = vars[name];
    return typeof value === "string" ? value : "";
  };
  const secret = (name: string): string => process.env[name] ?? "";
  return {
    JEV_BASE_URL: variable("JEV_BASE_URL"),
    JEV_MODEL: variable("JEV_MODEL"),
    ANTHROPIC_BASE_URL: variable("ANTHROPIC_BASE_URL"),
    ANTHROPIC_MODEL: variable("ANTHROPIC_MODEL"),
    AI_GATEWAY_BASE_URL: variable("AI_GATEWAY_BASE_URL"),
    AI_GATEWAY_ACCOUNT_ID: variable("AI_GATEWAY_ACCOUNT_ID"),
    AI_GATEWAY_ID: variable("AI_GATEWAY_ID"),
    GITHUB_API_BASE_URL: variable("GITHUB_API_BASE_URL"),
    TYPESAFE_API_KEY: secret("TYPESAFE_API_KEY"),
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
    AI_GATEWAY_TOKEN: secret("AI_GATEWAY_TOKEN"),
    GITHUB_TOKEN: secret("GITHUB_TOKEN"),
  };
}

const passed = await runContractChecks(CONTRACT_CHECKS, contractConfig(), fetch, (line) => {
  process.stdout.write(`${line}\n`);
});
process.exitCode = passed ? 0 : 1;
