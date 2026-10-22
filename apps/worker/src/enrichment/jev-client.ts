// The client for Jev, TypeSafe's System One model (#122). See "Jev client", Q3 and "Enrichment
// sweep" in plans/haystack-v1-implementation-plan.md. It asks one question per request, because
// enrichment asks its two questions at different steps: the `kind` question may only be asked
// after the sensitivity answer allows it.
//
// The request and response fields, the status codes and the retry advice come from TypeSafe's API
// reference (https://docs.typesafe.ai/api/system-one.md) and its errors page
// (https://docs.typesafe.ai/api/errors.md), read on 2026-10-22.
//
// The limits:
// - At most JEV_ATTEMPT_LIMIT requests per question, because Q3 counts 3 per question when it
//   sizes the sweep. Every attempt counts, a timed-out one included.
// - Each attempt, from the request to the last byte of the response, stops after
//   `attemptTimeoutMs`.
// - The key is sent only in the `authorization` header, only to JEV_BASE_URL, and only over
//   https. Redirects are not followed, so the key can't be sent on to another address.
// - Nothing here logs. A failure is a fixed code and a status, which are safe to log.
import * as v from "valibot";

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

/** The time limits. The tests shorten them. */
export interface JevTiming {
  readonly attemptTimeoutMs: number;
  readonly backoffInitialMs: number;
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
 * A transient failure may succeed later, and enrichment only records it. A permanent one
 * won't, and counts toward the attempt limit (see "Enrichment sweep" in the plan).
 */
export type JevFailureClass = "transient" | "permanent";

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

// The fields of a response that Haystack reads. Fields it does not read, such as
// `usage.output_tokens`, aren't checked, so a change to them can't fail an answer.
const SystemOneResponse = v.object({
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

// 429 and 529 are the statuses the errors page says to retry. A 408 is a timeout, and any other
// 5xx is a failure on TypeSafe's side, so both are transient too, as they are for the TypeSafe
// SDKs. A redirect and any other 4xx are permanent: the same request would get the same answer.
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
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
        failure: isTransientStatus(status) ? "transient" : "permanent",
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
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

/**
 * Asks Jev one question. Transient failures are retried, with a backoff between attempts, up to
 * JEV_ATTEMPT_LIMIT requests in all; a permanent failure ends the question at once. Throws for
 * an empty key or a base URL that isn't https, before anything is sent, because those are
 * configuration errors rather than failures of the question.
 */
export async function askJev<Answer>(
  config: JevConfig,
  { state, id, question, answer }: JevAsk<Answer>,
  timing: JevTiming = JEV_TIMING,
): Promise<JevResult<Answer>> {
  // An empty secret is easy to store by mistake (#98), and TypeSafe would only answer 401.
  if (config.TYPESAFE_API_KEY.trim() === "") {
    throw Object.assign(new Error("TYPESAFE_API_KEY is empty"), {
      code: "TYPESAFE_API_KEY_EMPTY",
    });
  }
  const url = new URL("/v1/systemone", config.JEV_BASE_URL);
  if (url.protocol !== "https:") {
    throw new TypeError("JEV_BASE_URL must be an https URL");
  }
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.TYPESAFE_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ model: config.JEV_MODEL, state, questions: { [id]: question } }),
    redirect: "manual",
  };
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
    if (outcome.failure === "permanent" || attempts === JEV_ATTEMPT_LIMIT) {
      return failure;
    }
    const delay = retryDelayMs(attempts, outcome.headers, timing);
    if (delay === undefined) {
      return failure;
    }
    await sleep(delay);
  }
}
