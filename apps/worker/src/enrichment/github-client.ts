// The client that reads what GitHub says about a repository, for enrichment (#123). See "GitHub
// enrichment", Q3, Q7 and "Untrusted content" in plans/haystack-v1-implementation-plan.md. Nothing
// in production calls it yet: the enrichment module (#126) is its first caller.
//
// The endpoints, headers, media types and statuses come from GitHub's REST reference, read on
// 2026-10-22: "Get a repository" (https://docs.github.com/en/rest/repos/repos#get-a-repository),
// "Get a repository README" (https://docs.github.com/en/rest/repos/contents#get-a-repository-readme),
// "Getting started with the REST API", "API Versions" and "Rate limits for the REST API".
//
// The limits:
// - At most 2 requests, each made once: the repository, then its README. Q3 counts exactly these
//   when it sizes the sweep, so nothing is retried. A failure returns no data, and enrichment
//   falls back to the captured payload.
// - Only the repository's path goes to GitHub (Q7): never the bookmarked URL, its query or the
//   page within the repository.
// - Each request, from the request to the last byte read, stops after `requestTimeoutMs`. Only
//   the first GITHUB_README_READ_LIMIT_BYTES of a README are read.
// - The token is sent only in the `authorization` header, only to GITHUB_API_BASE_URL, and only
//   over https. Redirects are not followed, so the token can't be sent on to another address.
// - The README is untrusted: it only becomes text, and nothing in it changes what this does.
// - Nothing here logs. A failure is a fixed code and a status, which are safe to log.
import { truncate } from "@haystack/schemas";
import * as v from "valibot";
import type { GitHubRepositoryMatch } from "./github-url.ts";
import { readmeExcerpt } from "./readme-excerpt.ts";

/** The configuration the client reads. `Env` has these, from `vars` and `secrets.required`. */
export interface GitHubConfig {
  // The REST API's origin, https://api.github.com in production.
  GITHUB_API_BASE_URL: string;
  // A fine-grained personal access token that can read public repositories only (see the plan).
  GITHUB_TOKEN: string;
}

/**
 * The REST API version the client is written against, from "API Versions"
 * (https://docs.github.com/en/rest/about-the-rest-api/api-versions). A request without the header
 * gets 2022-11-28. The fields read here are the same in both.
 */
export const GITHUB_API_VERSION = "2026-03-10";

/**
 * GitHub rejects a request without a User-Agent, and asks for the application's name, so it can
 * get in touch about problems. The sweep runs without a request, so there is no site address to
 * name, as the page lookup does: the project's repository names Haystack instead.
 */
export const GITHUB_USER_AGENT = "Haystack (+https://github.com/schalkneethling/haystack)";

/**
 * How long one request may take, body included. Both answers are small, the README because only
 * its start is read, so this is the page lookup's 3 seconds, and the two requests together add at
 * most 6 seconds to a bookmark's enrichment. GitHub's documentation gives no response times.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 3000;

/**
 * How much of a README is read, in bytes. A README often starts with badges, logos and HTML
 * that leave no text, so this is several times the excerpt, and it bounds the CPU time that
 * removing the Markdown takes. The rest of the README is never downloaded.
 */
export const GITHUB_README_READ_LIMIT_BYTES = 16 * 1024;

// How much of the repository's JSON is read. A repository's JSON is a few kilobytes, and a fork
// with its parent and source about three times that. A larger one isn't read.
const REPOSITORY_READ_LIMIT_BYTES = 64 * 1024;

// Caps on what GitHub returns, so a repository can't fill the Jev state or the prompt. GitHub
// allows at most 20 topics of up to 50 characters each ("Classifying your repository with
// topics"). It documents no limit for the description or the language.
const DESCRIPTION_CAP = 500;
const LANGUAGE_CAP = 100;
const TOPIC_LIMIT = 20;
const TOPIC_CAP = 50;

/** The time limit. The tests shorten it. */
export interface GitHubTiming {
  readonly requestTimeoutMs: number;
}

export const GITHUB_TIMING: GitHubTiming = { requestTimeoutMs: GITHUB_REQUEST_TIMEOUT_MS };

/**
 * What GitHub says about the repository a bookmark is in, as the `github` state of the `kind`
 * question and the LLM's GitHub evidence. A key is absent when GitHub has no value for it.
 * `bookmark_is` says whether the bookmark is the repository itself or a page within it, such as
 * an issue, so the page is not described as the repository.
 */
export interface GitHubEvidence {
  // `owner/repo`, as the bookmark's URL names it.
  readonly repository: string;
  readonly bookmark_is: "the repository" | "a page within the repository";
  readonly description?: string;
  readonly topics?: readonly string[];
  // The repository's primary language.
  readonly language?: string;
  // The README's first README_EXCERPT_LENGTH characters of text, without Markdown. Untrusted.
  readonly readme_excerpt?: string;
}

/**
 * Why a request gave nothing, as a fixed code that is safe to log:
 * - `timeout`: the request took longer than its time limit, body included.
 * - `network`: the request failed, or the response's body stopped before its end.
 * - `not-found`: GitHub answered 404. For the repository, that includes a private one, which the
 *   token can't read. For the README, the repository has none.
 * - `rate-limited`: a 429, or a 403 that GitHub marks as a rate limit.
 * - `status`: any other answer that isn't 2xx, including a redirect, which `status` holds.
 * - `invalid-response`: a 2xx response that isn't what the endpoint documents.
 * - `private`: GitHub answered for a repository that isn't public, so the token can read more
 *   than it should. Nothing more is asked, and nothing is returned.
 */
export type GitHubFailureReason =
  | "timeout"
  | "network"
  | "not-found"
  | "rate-limited"
  | "status"
  | "invalid-response"
  | "private";

export interface GitHubRequestFailure {
  readonly reason: GitHubFailureReason;
  // The response's status, for a failure that had one.
  readonly status?: number;
}

export interface GitHubFailure extends GitHubRequestFailure {
  readonly ok: false;
  // How many requests were made.
  readonly requests: number;
}

export interface GitHubSuccess {
  readonly ok: true;
  readonly evidence: GitHubEvidence;
  // Why there is no excerpt, when the README couldn't be read. `not-found` means it has none.
  readonly readmeFailure?: GitHubRequestFailure;
  readonly requests: number;
}

export type GitHubResult = GitHubSuccess | GitHubFailure;

// The fields of "Get a repository" that Haystack reads. Fields it doesn't read aren't checked, so
// a change to them can't fail the read. `private` is required, and `description` and `language`
// are required but may be null. `topics` is optional.
const RepositoryResponse = v.object({
  private: v.boolean(),
  description: v.nullable(v.string()),
  language: v.nullable(v.string()),
  topics: v.optional(v.array(v.string())),
});

type Read = { readonly ok: true; readonly text: string; readonly complete: boolean };

type RequestOutcome = Read | ({ readonly ok: false } & GitHubRequestFailure);

function discard(response: Response): void {
  response.body?.cancel().catch(() => {
    // Nothing more is wanted from this response.
  });
}

// GitHub answers a rate limit with a 429, or a 403 with `x-ratelimit-remaining: 0` or a
// `retry-after` ("Exceeding the rate limit"). Any other 403 is a refusal.
function failureForStatus(response: Response): GitHubRequestFailure {
  const { status, headers } = response;
  if (status === 404) {
    return { reason: "not-found", status };
  }
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining")?.trim() === "0" || headers.has("retry-after")));
  return { reason: rateLimited ? "rate-limited" : "status", status };
}

// The body as UTF-8 text, up to `limit` bytes. The rest is cancelled, never downloaded, and a
// character cut at the limit is dropped.
async function readText(body: ReadableStream<Uint8Array>, limit: number): Promise<Read> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return { ok: true, text: text + decoder.decode(), complete: true };
    }
    const room = limit - bytes;
    if (chunk.value.byteLength >= room) {
      text += decoder.decode(chunk.value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => {
        // The rest of the body is not wanted.
      });
      return { ok: true, text, complete: false };
    }
    bytes += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

async function request(
  url: URL,
  headers: Record<string, string>,
  limit: number,
  timeoutMs: number,
): Promise<RequestOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", headers, redirect: "manual", signal });
    if (!response.ok) {
      discard(response);
      return { ok: false, ...failureForStatus(response) };
    }
    if (response.body === null) {
      return { ok: true, text: "", complete: true };
    }
    // Read here, inside the time limit, so a body that stops arriving times out too.
    return await readText(response.body, limit);
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
}

// The repository's fields, cut to their caps, with an empty value left out.
function repositoryEvidence(
  match: GitHubRepositoryMatch,
  repository: v.InferOutput<typeof RepositoryResponse>,
): GitHubEvidence {
  const description = truncate(repository.description?.trim() ?? "", DESCRIPTION_CAP);
  const language = truncate(repository.language?.trim() ?? "", LANGUAGE_CAP);
  const topics = (repository.topics ?? [])
    .map((topic) => truncate(topic.trim(), TOPIC_CAP))
    .filter((topic) => topic !== "")
    .slice(0, TOPIC_LIMIT);
  return {
    repository: `${match.owner}/${match.repo}`,
    bookmark_is:
      match.bookmark === "repository" ? "the repository" : "a page within the repository",
    ...(description === "" ? {} : { description }),
    ...(topics.length === 0 ? {} : { topics }),
    ...(language === "" ? {} : { language }),
  };
}

function parseRepository(text: string): v.InferOutput<typeof RepositoryResponse> | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = v.safeParse(RepositoryResponse, json);
  return parsed.success ? parsed.output : undefined;
}

/**
 * Reads the repository that `match` names: its description, topics and primary language, and
 * an excerpt of its README. A missing or unreadable README still returns the repository's data.
 * Any other failure returns no data, and nothing is retried. Throws for an empty token or a base
 * URL that isn't https, before anything is sent, because those are configuration errors rather
 * than failures of the bookmark.
 */
export async function readGitHubRepository(
  config: GitHubConfig,
  match: GitHubRepositoryMatch,
  timing: GitHubTiming = GITHUB_TIMING,
): Promise<GitHubResult> {
  // An empty secret is easy to store by mistake (#98), and GitHub would only answer 401. The
  // value can also be missing, although `Env` says `string`: the test harness and local
  // development don't bind a required secret they can't find.
  if (!config.GITHUB_TOKEN || config.GITHUB_TOKEN.trim() === "") {
    throw Object.assign(new Error("GITHUB_TOKEN is empty"), { code: "GITHUB_TOKEN_EMPTY" });
  }
  const path = `/repos/${encodeURIComponent(match.owner)}/${encodeURIComponent(match.repo)}`;
  const repositoryUrl = new URL(path, config.GITHUB_API_BASE_URL);
  if (repositoryUrl.protocol !== "https:") {
    throw new TypeError("GITHUB_API_BASE_URL must be an https URL");
  }
  const headers = {
    authorization: `Bearer ${config.GITHUB_TOKEN}`,
    "user-agent": GITHUB_USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };

  const repositoryOutcome = await request(
    repositoryUrl,
    { ...headers, accept: "application/vnd.github+json" },
    REPOSITORY_READ_LIMIT_BYTES,
    timing.requestTimeoutMs,
  );
  if (!repositoryOutcome.ok) {
    const { reason, status } = repositoryOutcome;
    return { ok: false, reason, ...(status === undefined ? {} : { status }), requests: 1 };
  }
  const repository = repositoryOutcome.complete
    ? parseRepository(repositoryOutcome.text)
    : undefined;
  if (repository === undefined) {
    return { ok: false, reason: "invalid-response", requests: 1 };
  }
  // The token should only read public repositories, and then GitHub answers 404 for a private
  // one. If it can read more, this keeps a private README from being fetched or sent on.
  if (repository.private) {
    return { ok: false, reason: "private", requests: 1 };
  }
  const evidence = repositoryEvidence(match, repository);

  // The raw media type returns the README's own text, Markdown and all, rather than JSON with
  // the content in base64, so it can be read a few kilobytes at a time.
  const readmeOutcome = await request(
    new URL(`${path}/readme`, config.GITHUB_API_BASE_URL),
    { ...headers, accept: "application/vnd.github.raw+json" },
    GITHUB_README_READ_LIMIT_BYTES,
    timing.requestTimeoutMs,
  );
  if (!readmeOutcome.ok) {
    const { reason, status } = readmeOutcome;
    return {
      ok: true,
      evidence,
      readmeFailure: { reason, ...(status === undefined ? {} : { status }) },
      requests: 2,
    };
  }
  // A README cut at the read limit ends in a line cut anywhere, perhaps in the middle of a link,
  // so that line is left out.
  const { text, complete } = readmeOutcome;
  const excerpt = readmeExcerpt(
    complete ? text : text.slice(0, Math.max(text.lastIndexOf("\n"), 0)),
  );
  return {
    ok: true,
    evidence: excerpt === "" ? evidence : { ...evidence, readme_excerpt: excerpt },
    requests: 2,
  };
}
