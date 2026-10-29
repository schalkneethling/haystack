// Runs the contract checks (contract-checks.ts, #203) and reports one line for each: passed, or
// why not. See "Testing strategy" in plans/haystack-v1-implementation-plan.md.
//
// The report never holds a key or anything from a response. Each line is built from the check's
// name and a fixed set of facts: a field's path in the client's schema, a status code, the time
// limit, or a configuration error's code. A response's body, a validation message (Valibot's
// messages quote the value they received) and an error's message are never printed, because
// any of them could hold a key that a service echoed back.
import * as v from "valibot";
import type { ContractCheck, ContractConfig, ResponsePart } from "./contract-checks.ts";

/** The `fetch` a check sends its one request with. The tests give one that answers fixtures. */
export type ContractFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** What happened to a check's request, as facts that are safe to print. */
export type ContractOutcome =
  | { readonly result: "passed" }
  // The request wasn't sent, because the client found a configuration error, such as an empty
  // key, which `code` names.
  | { readonly result: "not-sent"; readonly code: string }
  | { readonly result: "timeout"; readonly timeoutMs: number }
  | { readonly result: "network" }
  | { readonly result: "status"; readonly status: number }
  | { readonly result: "not-json" }
  // `field` is the dot path of the first part of the response that didn't validate.
  | { readonly result: "invalid"; readonly field: string };

// A configuration error's code, such as `TYPESAFE_API_KEY_EMPTY`, is a fixed name. Anything else
// thrown while the request is built isn't printed.
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

function errorCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNEXPECTED_ERROR";
}

// The value at `path` in `json`, or undefined when there is none.
function at(json: unknown, path: readonly string[]): unknown {
  let value = json;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * The dot path of the first field that doesn't validate, or undefined when every part does. A
 * missing part, or a part that fails as a whole, is named by its own path.
 */
export function invalidField(json: unknown, parts: readonly ResponsePart[]): string | undefined {
  for (const { path, schema } of parts) {
    const parsed = v.safeParse(schema, at(json, path));
    if (!parsed.success) {
      const field = [...path, v.getDotPath(parsed.issues[0]) ?? ""]
        .filter((key) => key !== "")
        .join(".");
      return field === "" ? "(the whole response)" : field;
    }
  }
  return undefined;
}

/**
 * Sends the check's one request and validates its answer. It never retries, so a check costs one
 * request at most, and none when the client finds a configuration error first.
 */
export async function runContractCheck(
  check: ContractCheck,
  config: ContractConfig,
  fetcher: ContractFetch,
): Promise<ContractOutcome> {
  let request: ReturnType<ContractCheck["request"]>;
  try {
    request = check.request(config);
  } catch (error) {
    return { result: "not-sent", code: errorCode(error) };
  }
  const signal = AbortSignal.timeout(check.timeoutMs);
  let body: string;
  try {
    const response = await fetcher(request.url, { ...request.init, signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {
        // Nothing more is wanted from this response.
      });
      return { result: "status", status: response.status };
    }
    // Read here, inside the time limit, as the clients read it.
    body = await response.text();
  } catch {
    return signal.aborted
      ? { result: "timeout", timeoutMs: check.timeoutMs }
      : { result: "network" };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { result: "not-json" };
  }
  const field = invalidField(json, check.parts);
  return field === undefined ? { result: "passed" } : { result: "invalid", field };
}

/** The report's line for one check. */
export function reportLine(name: string, outcome: ContractOutcome): string {
  switch (outcome.result) {
    case "passed":
      return `${name}: passed`;
    case "not-sent":
      return `${name}: not sent, ${outcome.code}`;
    case "timeout":
      return `${name}: failed, no answer within ${outcome.timeoutMs / 1000} s`;
    case "network":
      return `${name}: failed, network error`;
    case "status":
      return `${name}: failed, HTTP ${outcome.status}`;
    case "not-json":
      return `${name}: failed, the response isn't JSON`;
    case "invalid":
      return `${name}: failed, ${outcome.field} didn't validate`;
  }
}

/**
 * Runs every check in turn, one request at a time, and writes one line for each. Returns
 * whether every check passed.
 */
export async function runContractChecks(
  checks: readonly ContractCheck[],
  config: ContractConfig,
  fetcher: ContractFetch,
  write: (line: string) => void,
): Promise<boolean> {
  let passed = true;
  for (const check of checks) {
    const outcome = await runContractCheck(check, config, fetcher);
    write(reportLine(check.name, outcome));
    passed &&= outcome.result === "passed";
  }
  return passed;
}
