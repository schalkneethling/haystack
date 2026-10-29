// The client for Jev, TypeSafe's System One model (#122). See "Jev client", Q3 and "Enrichment
// sweep" in plans/haystack-v1-implementation-plan.md. It asks one question per request, because
// enrichment asks its two questions at different steps: the `kind` question may only be asked
// after the sensitivity answer allows it.
//
// The request and response fields, the status codes and the retry advice come from TypeSafe's API
// reference (https://docs.typesafe.ai/api/system-one.md) and its errors page
// (https://docs.typesafe.ai/api/errors.md), read on 2026-10-22, and again on 2026-10-28 for
// jev-1.14.0 (#201), when the fields read here were unchanged.
//
// The limits:
// - At most JEV_ATTEMPT_LIMIT requests per question, because Q3 counts 3 per question when it
//   sizes the sweep. Every attempt counts, a timed-out one included.
// - Each attempt, from the request to the last byte of the response, stops after
//   `attemptTimeoutMs`.
// - The key is sent only in the `authorization` header, only to JEV_BASE_URL, and only over
//   https, or over http to a loopback host, where the integration tests' recorded server runs
//   (see "Testing strategy" in the plan). Redirects are not followed, so the key can't be sent on
//   to another address.
// - Nothing here logs. A failure is a fixed code and a status, which are safe to log.
import * as v from "valibot";
import { checkedBaseUrl, configurationError } from "./configuration.ts";
import { type FailureClass, statusFailureClass } from "./failure-class.ts";

/** The configuration the client reads. `Env` has these, from `vars` and `secrets.required`. */
export interface JevConfig {
  // TypeSafe's API origin. The request goes to `/v1/systemone` on it.
  JEV_BASE_URL: string;
  // The pinned model, so answers stay comparable until a deliberate upgrade.
  JEV_MODEL: string;
  TYPESAFE_API_KEY: string;
}

/** How many requests one question makes at most. */
export const JEV_ATTEMPT_LIMIT = 3;

/** How long one attempt may take. The documentation's own examples answer in under a second. */
export const JEV_ATTEMPT_TIMEOUT_MS = 5000;

/** The first retry's delay. Each later one doubles it, as the TypeSafe SDKs do by default. */
export const JEV_BACKOFF_INITIAL_MS = 500;

/**
 * The longest the client waits before a retry. A `Retry-After` longer than this means the
 * answer won't come within this question's attempts, so the client stops rather than retry early.
 */
export const JEV_MAX_RETRY_DELAY_MS = 5000;

// Up to this fraction of each backoff delay is randomly taken off, as in the TypeSafe SDKs, so
// clients that failed together don't all retry at the same moment.
const BACKOFF_JITTER = 0.25;

/**
 * How long a question may take: each attempt's time limit, the first backoff, and how many
 * attempts it makes. The tests shorten them, and the save form's check (#132) makes one attempt.
 */
export interface JevTiming {
  readonly attemptTimeoutMs: number;
  readonly backoffInitialMs: number;
  // A whole number from 1, and JEV_ATTEMPT_LIMIT when absent. A larger value is capped to
  // JEV_ATTEMPT_LIMIT. Any other value, such as 0, -1, 0.5 or NaN, throws a RangeError before
  // anything is sent (checkedAttemptLimit).
  readonly attemptLimit?: number;
}

// The timing's attempt limit, capped to JEV_ATTEMPT_LIMIT. A limit that isn't a whole number
// from 1 is a bug in the caller, which would otherwise make one attempt or, for NaN, retry for
// good, so it throws.
function checkedAttemptLimit({ attemptLimit = JEV_ATTEMPT_LIMIT }: JevTiming): number {
  if (!Number.isInteger(attemptLimit) || attemptLimit < 1) {
    throw new RangeError(`attemptLimit is ${attemptLimit}, which isn't a whole number from 1`);
  }
  return Math.min(attemptLimit, JEV_ATTEMPT_LIMIT);
}

export const JEV_TIMING: JevTiming = {
  attemptTimeoutMs: JEV_ATTEMPT_TIMEOUT_MS,
  backoffInitialMs: JEV_BACKOFF_INITIAL_MS,
};

/** What the API accepts as `state`, `instructions` or a criterion: a string, an object or an array. */
export type JevContent = string | object;

/** A yes/no question. A high answer must mean yes. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: JevContent;
  readonly criteria?: { readonly true: JevContent; readonly false: JevContent };
}

/** A question that picks one of `criteria`'s keys, each described by its value. */
export interface ChoiceQuestion<Option extends string> {
  readonly type: "choice";
  readonly instructions: JevContent;
  readonly criteria: Readonly<Record<Option, JevContent>>;
}

/**
 * Why a question got no answer, as a fixed code that is safe to log:
 * - `timeout`: an attempt took longer than its time limit.
 * - `network`: the request failed, or the response's body stopped before its end.
 * - `status`: TypeSafe answered with a status other than 2xx, which `status` holds.
 * - `invalid-response`: a 2xx response that isn't the answer to the question that was asked.
 */
export type JevFailureReason = "timeout" | "network" | "status" | "invalid-response";

/**
 * A transient failure may succeed later, and a permanent one won't (see "Enrichment sweep" in the
 * plan). An `account` one is a rejected key, which the run stops for (failure-class.ts, #127).
 */
export type JevFailureClass = FailureClass;

export interface JevFailure {
  readonly ok: false;
  readonly failure: JevFailureClass;
  readonly reason: JevFailureReason;
  // The status of the last response, for a `status` failure.
  readonly status?: number;
  // How many requests the question made.
  readonly attempts: number;
}

export interface JevSuccess<Answer> {
  readonly ok: true;
  readonly answer: Answer;
  // The model that answered, as the response names it.
  readonly model: string;
  // `usage.input_tokens`, the billed input.
  readonly inputTokens: number;
  readonly attempts: number;
}

export type JevResult<Answer> = JevSuccess<Answer> | JevFailure;

/** A probability, from 0 to 1. */
const Probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

/** A Noul answer, as the probability that the answer is yes. */
export const NoulAnswer = v.pipe(
  v.object({ type: v.literal("noul"), noul: Probability }),
  v.transform(({ noul }) => noul),
);

/**
 * A Choice answer over `options`: the chosen option, and a probability for every option and
 * no other. The API also returns a `confidence`, which Haystack does not use, so it isn't
 * checked.
 */
export function choiceAnswer<const Option extends string>(options: readonly [Option, ...Option[]]) {
  return v.pipe(
    v.object({
      type: v.literal("choice"),
      choice: v.picklist(options),
      probabilities: v.pipe(
        v.record(v.string(), Probability),
        v.check(
          (probabilities) =>
            Object.keys(probabilities).length === options.length &&
            options.every((option) => Object.hasOwn(probabilities, option)),
          "The probabilities must name every option and no other",
        ),
        v.transform(
          (probabilities) =>
            Object.fromEntries(options.map((option) => [option, probabilities[option]])) as Record<
              Option,
              number
            >,
        ),
      ),
    }),
    v.transform(({ choice, probabilities }) => ({ choice, probabilities })),
  );
}

/**
 * The fields of a response that Haystack reads. Fields it does not read, such as
 * `usage.output_tokens`, aren't checked, so a change to them can't fail an answer. The contract
 * check (evals/contract-checks.ts, #203) validates TypeSafe's live answer with it too.
 */
export const SystemOneResponse = v.object({
  model: v.pipe(v.string(), v.nonEmpty()),
  answers: v.record(v.string(), v.unknown()),
  usage: v.object({ input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
});

type AttemptOutcome =
  | { readonly ok: true; readonly body: string }
  | {
      readonly ok: false;
      readonly failure: JevFailureClass;
      readonly reason: JevFailureReason;
      readonly status?: number;
      readonly headers?: Headers;
    };

function discard(response: Response): void {
  response.body?.cancel().catch(() => {
    // Nothing more is wanted from this response.
  });
}

async function attempt(url: URL, init: RequestInit, timeoutMs: number): Promise<AttemptOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      discard(response);
      const { status, headers } = response;
      return {
        ok: false,
        // 429 and 529 are the statuses the errors page says to retry. A 408 and any other 5xx are
        // transient too, as they are for the TypeSafe SDKs. A 401 is the key, the errors page's
        // "Missing or invalid API key", so it is the account's failure (#127).
        failure: statusFailureClass(status),
        reason: "status",
        status,
        headers,
      };
    }
    // Read here, inside the time limit, so a body that stops arriving times out too.
    return { ok: true, body: await response.text() };
  } catch {
    return { ok: false, failure: "transient", reason: signal.aborted ? "timeout" : "network" };
  }
}

// How long the server asks the client to wait, from `retry-after-ms` or `Retry-After` in
// seconds. The models page says the TypeSafe SDKs follow `retry-after`, and the SDK reference
// names both headers. A `Retry-After` date is not read, and the backoff applies instead.
function serverDelayMs(headers: Headers | undefined): number | undefined {
  const milliseconds = headers?.get("retry-after-ms")?.trim();
  if (milliseconds !== undefined && /^\d+(?:\.\d+)?$/.test(milliseconds)) {
    return Number(milliseconds);
  }
  const seconds = headers?.get("retry-after")?.trim();
  if (seconds !== undefined && /^\d+$/.test(seconds)) {
    return Number(seconds) * 1000;
  }
  return undefined;
}

// The delay before the next attempt, after `failedAttempts` attempts, or undefined when the
// server asks for a longer wait than JEV_MAX_RETRY_DELAY_MS.
function retryDelayMs(
  failedAttempts: number,
  headers: Headers | undefined,
  timing: JevTiming,
): number | undefined {
  const requested = serverDelayMs(headers);
  if (requested !== undefined && requested > JEV_MAX_RETRY_DELAY_MS) {
    return undefined;
  }
  const backoff = Math.min(
    timing.backoffInitialMs * 2 ** (failedAttempts - 1) * (1 - BACKOFF_JITTER * Math.random()),
    JEV_MAX_RETRY_DELAY_MS,
  );
  return Math.max(backoff, requested ?? 0);
}

// Waits `milliseconds`, or until `signal` is aborted, whichever comes first.
function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// The answer to question `id` in a 2xx response's body, or undefined when the body isn't one.
function parseAnswer<Answer>(
  body: string,
  id: string,
  schema: v.GenericSchema<unknown, Answer>,
): { model: string; inputTokens: number; answer: Answer } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const response = v.safeParse(SystemOneResponse, json);
  if (!response.success || !Object.hasOwn(response.output.answers, id)) {
    return undefined;
  }
  const answer = v.safeParse(schema, response.output.answers[id]);
  if (!answer.success) {
    return undefined;
  }
  return {
    model: response.output.model,
    inputTokens: response.output.usage.input_tokens,
    answer: answer.output,
  };
}

/** One question for Jev, with the state it is about and the schema of its answer. */
export interface JevAsk<Answer> {
  readonly state: JevContent;
  // The question's name in the request and the response. It isn't sent to the model.
  readonly id: string;
  readonly question: NoulQuestion | ChoiceQuestion<string>;
  readonly answer: v.GenericSchema<unknown, Answer>;
}

// The endpoint every question is posted to, once the configuration is checked. Throws for an
// empty key, or for a base URL that is missing, doesn't parse, or is neither https nor http on a
// loopback host.
function endpoint(config: JevConfig): URL {
  // An empty secret is easy to store by mistake (#98), and TypeSafe would only answer 401. The
  // value can also be missing, although `Env` says `string`: the test harness and local
  // development don't bind a required secret they can't find.
  if (!config.TYPESAFE_API_KEY || config.TYPESAFE_API_KEY.trim() === "") {
    throw configurationError("TYPESAFE_API_KEY is empty", "TYPESAFE_API_KEY_EMPTY");
  }
  // Integration tests point the base URL at a plain-http server on this machine (Q10), so http
  // is allowed there, by the same rule as the GitHub client, the LLM adapters and Google
  // sign-in's endpoints (#126). The error's code is `JEV_BASE_URL_INVALID` (#155).
  return new URL("/v1/systemone", checkedBaseUrl("JEV_BASE_URL", config.JEV_BASE_URL));
}

/** The questions of one request, each under the name its answer comes back under. */
export type JevQuestions = Readonly<Record<string, NoulQuestion | ChoiceQuestion<string>>>;

/**
 * The request that asks `questions` about `state`: the pinned model, the key in the
 * `authorization` header, and no redirects followed. It throws the configuration errors `askJev`
 * throws, before anything is sent. askJev sends it with one question. The contract check
 * (evals/contract-checks.ts, #203) sends it once with fixed questions and a fixed state, so the
 * live request that check makes is this one.
 */
export function jevRequest(
  config: JevConfig,
  state: JevContent,
  questions: JevQuestions,
): { readonly url: URL; readonly init: RequestInit } {
  return {
    url: endpoint(config),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.TYPESAFE_API_KEY}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ model: config.JEV_MODEL, state, questions }),
      redirect: "manual",
    },
  };
}

/**
 * Throws for the configuration error that `askJev` would throw, and sends nothing. The
 * enrichment module calls it before it sends anything for a bookmark, so a missing key is found
 * before any other service is asked (#126).
 */
export function assertJevConfig(config: JevConfig): void {
  endpoint(config);
}

/**
 * Asks Jev one question. Transient failures are retried, with a backoff between attempts, up to
 * the timing's attempt limit, which is JEV_ATTEMPT_LIMIT requests in all at most; a permanent or
 * `account` failure ends the question at once.
 * Throws for an empty key, or for a base URL that is missing, doesn't parse, or is neither https
 * nor http on a loopback host, before anything is sent, because those are configuration errors
 * rather than failures of the question. It throws a RangeError, before anything is sent, for an
 * attempt limit that isn't a whole number from 1, which is a bug in the caller.
 *
 * A `signal` that is already aborted, as a sweep run's is once the run stops (#127), throws its
 * reason before anything is sent. Once it is aborted later, no other attempt is made and no
 * backoff is waited out: the last attempt's failure is returned. An attempt under
 * way still runs to its answer or its own time limit, because the signal isn't given to `fetch`.
 * The on-save path passes no signal.
 */
export async function askJev<Answer>(
  config: JevConfig,
  { state, id, question, answer }: JevAsk<Answer>,
  timing: JevTiming = JEV_TIMING,
  signal?: AbortSignal,
): Promise<JevResult<Answer>> {
  signal?.throwIfAborted();
  const { url, init } = jevRequest(config, state, { [id]: question });
  const attemptLimit = checkedAttemptLimit(timing);
  for (let attempts = 1; ; attempts += 1) {
    const outcome = await attempt(url, init, timing.attemptTimeoutMs);
    if (outcome.ok) {
      const parsed = parseAnswer(outcome.body, id, answer);
      return parsed === undefined
        ? { ok: false, failure: "permanent", reason: "invalid-response", attempts }
        : { ok: true, ...parsed, attempts };
    }
    const failure: JevFailure = {
      ok: false,
      failure: outcome.failure,
      reason: outcome.reason,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      attempts,
    };
    // An `account` failure would get the same answer again, as a permanent one would. A run that
    // has stopped wants no more paid attempts.
    if (outcome.failure !== "transient" || attempts >= attemptLimit || signal?.aborted) {
      return failure;
    }
    const delay = retryDelayMs(attempts, outcome.headers, timing);
    if (delay === undefined) {
      return failure;
    }
    await sleep(delay, signal);
    if (signal?.aborted) {
      return failure;
    }
  }
}
