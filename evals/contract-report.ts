// Runs the contract checks (contract-checks.ts, #203) and reports one line for each: passed, or
// why not. See "Testing strategy" in plans/haystack-v1-implementation-plan.md.
//
// The report never holds a key or anything from a response. Each line is built from the check's
// name and a fixed set of facts: a field's path in the client's schema, a status code, the time
// limit, a configuration error's code, or an unexpected error's name. A response's body, a key
// the response chose (such as a key of a record), a validation message (Valibot's messages quote
// the value they received) and an error's message are never printed, because any of them could
// hold a key that a service echoed back.
import * as v from "valibot";
import type { ContractCheck, ContractConfig, ResponsePart } from "./contract-checks.ts";

/** The `fetch` a check sends its one request with. The tests give one that answers fixtures. */
export type ContractFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** What happened to a check's request, as facts that are safe to print. */
export type ContractOutcome =
  | { readonly result: "passed" }
  // The request wasn't sent, because the client found a configuration error, such as an empty
  // key, which `code` names. For anything else thrown while the request was built, `code` is
  // UNEXPECTED_ERROR, and `errorName` is the error's name, such as `TypeError`, when it has one.
  | { readonly result: "not-sent"; readonly code: string; readonly errorName?: string }
  | { readonly result: "timeout"; readonly timeoutMs: number }
  | { readonly result: "network" }
  | { readonly result: "status"; readonly status: number }
  | { readonly result: "not-json" }
  // `field` is the dot path of the first part of the response that didn't validate.
  | { readonly result: "invalid"; readonly field: string };

// A configuration error's code, such as `TYPESAFE_API_KEY_EMPTY`, is a fixed name. Of anything
// else thrown while the request is built, only a name that is a plain identifier, such as
// `TypeError`, is printed, so that a bug can be told apart from a configuration error.
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

// A property of a thrown value, when it is a string.
function stringProperty(error: unknown, name: "code" | "name"): string | undefined {
  if (typeof error !== "object" || error === null || !(name in error)) {
    return undefined;
  }
  const value: unknown = (error as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function notSent(error: unknown): ContractOutcome {
  const code = stringProperty(error, "code");
  if (code !== undefined && ERROR_CODE.test(code)) {
    return { result: "not-sent", code };
  }
  const name = stringProperty(error, "name");
  return {
    result: "not-sent",
    code: "UNEXPECTED_ERROR",
    ...(name !== undefined && ERROR_NAME.test(name) ? { errorName: name } : {}),
  };
}

// The schema an issue's path item leads into, when that item names a field of the schema: an
// entry of an object schema, or an item of an array schema. Wrappers such as `nullish` are
// looked through. A record's keys, and anything else, come from the response, so they lead
// nowhere.
function fieldSchema(schema: unknown, key: unknown): unknown {
  let current = schema;
  while (typeof current === "object" && current !== null && "wrapped" in current) {
    current = current.wrapped;
  }
  if (typeof current !== "object" || current === null || !("type" in current)) {
    return undefined;
  }
  if (
    typeof key === "string" &&
    "entries" in current &&
    typeof current.entries === "object" &&
    current.entries !== null &&
    Object.hasOwn(current.entries, key)
  ) {
    return (current.entries as Record<string, unknown>)[key];
  }
  if (typeof key === "number" && current.type === "array" && "item" in current) {
    return current.item;
  }
  return undefined;
}

// The keys of the issue's path that name fields of `schema`, up to the first that doesn't, such
// as a key of Jev's `probabilities` record, which the response chose. v.getDotPath would join
// that key in too.
function schemaPath(schema: v.GenericSchema, issue: v.BaseIssue<unknown>): string[] {
  const keys: string[] = [];
  let current: unknown = schema;
  for (const { key } of issue.path ?? []) {
    const next = fieldSchema(current, key);
    if (next === undefined) {
      break;
    }
    keys.push(String(key));
    current = next;
  }
  return keys;
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
 * missing part, or a part that fails as a whole, is named by its own path. The path holds only
 * the names of fields in the client's schema: a failure inside a record is named by the record.
 */
export function invalidField(json: unknown, parts: readonly ResponsePart[]): string | undefined {
  for (const { path, schema } of parts) {
    const parsed = v.safeParse(schema, at(json, path));
    if (!parsed.success) {
      const field = [...path, ...schemaPath(schema, parsed.issues[0])].join(".");
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
    return notSent(error);
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
      return outcome.errorName === undefined
        ? `${name}: not sent, ${outcome.code}`
        : `${name}: not sent, ${outcome.code} (${outcome.errorName})`;
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
