// The live requests of the contract check (#203), one for each outside API the enrichment clients
// call. See "Testing strategy" in plans/haystack-v1-implementation-plan.md, which says when to
// run it and how. The tests answer every outside request from recorded fixtures, so they can't
// notice a service that changed its answer. This check sends each request to the live service and
// validates the answer with the schemas the client uses, so it compares Haystack's fixtures and
// schemas with the live services. It is not a test of those services.
//
// What each request is made of:
// - The address and the headers are the client's own, from the function the client sends its own
//   request with (jevRequest, messagesRequestTarget with each adapter's transport, and
//   gitHubRepositoryRequest). So the gateway request carries `cf-aig-collect-log-payload: false`,
//   and a key goes only where the client sends it.
// - The body is a fixed constant here, as small as the API allows, and holds no bookmark data. The
//   only link in it is Haystack's own public repository, which every request names.
// - The schemas are imported from the clients, never copied, and each is applied where the client
//   applies it.
//
// Google's published keys have no check, because Haystack has no schema of its own for them:
// oauth4webapi reads them during sign-in (see "Testing strategy").
import { describeUrlForJudgment, type UrlDescription } from "@haystack/schemas";
import type * as v from "valibot";
import {
  type AiGatewayConfig,
  aiGatewayTransport,
} from "../apps/worker/src/enrichment/ai-gateway-provider.ts";
import {
  ANTHROPIC_REQUEST_TIMEOUT_MS,
  MessageResponse,
  messagesRequestTarget,
  type MessagesTransport,
} from "../apps/worker/src/enrichment/anthropic-messages.ts";
import {
  type AnthropicConfig,
  anthropicTransport,
} from "../apps/worker/src/enrichment/anthropic-provider.ts";
import {
  GITHUB_REQUEST_TIMEOUT_MS,
  type GitHubConfig,
  gitHubRepositoryRequest,
  RepositoryResponse,
} from "../apps/worker/src/enrichment/github-client.ts";
import { matchGitHubRepository } from "../apps/worker/src/enrichment/github-url.ts";
import {
  JEV_ATTEMPT_TIMEOUT_MS,
  type JevConfig,
  jevRequest,
  NoulAnswer,
  SystemOneResponse,
} from "../apps/worker/src/enrichment/jev-client.ts";
import {
  type CapturedEvidence,
  KIND_QUESTION,
  KindAnswerSchema,
  SENSITIVITY_QUESTION,
} from "../apps/worker/src/enrichment/jev-questions.ts";

/**
 * What the checks read: the Worker's `vars` from wrangler.jsonc, and its secrets. ANTHROPIC_MODEL
 * is the model both LLM adapters are given (provider-setting.ts).
 */
export type ContractConfig = JevConfig &
  AnthropicConfig &
  AiGatewayConfig &
  GitHubConfig & { readonly ANTHROPIC_MODEL: string };

/** A part of a response, and the schema the client checks that part with. */
export interface ResponsePart {
  // Where the part is in the response's JSON. No keys means the whole response.
  readonly path: readonly string[];
  readonly schema: v.GenericSchema;
}

/** One live request, and how its answer is checked. */
export interface ContractCheck {
  // The API and what the request asks, as the report names it.
  readonly name: string;
  // The client's own time limit for the request, body included.
  readonly timeoutMs: number;
  /**
   * The request, built by the client's own code. It throws the client's configuration error,
   * such as an empty key, before anything is sent.
   */
  request(config: ContractConfig): { readonly url: URL; readonly init: RequestInit };
  // Checked in order. The first part that doesn't validate is the one the report names.
  readonly parts: readonly ResponsePart[];
}

/**
 * The one link the requests name: Haystack's own repository, which is public, and which the
 * GitHub client's User-Agent names too. It is nobody's bookmark.
 */
export const CONTRACT_LINK = "https://github.com/schalkneethling/haystack";

const CONTRACT_TITLE = "Haystack";

// The questions' names in the request and the response, as askSensitivity and askKind name them.
const SENSITIVITY_ID = "private_access";
const KIND_ID = "kind";

/**
 * The state of the Jev request. `link` is what the sensitivity question reads, as
 * describeUrlForJudgment describes CONTRACT_LINK, and `bookmark` is what the `kind` question
 * reads. The production requests ask each question in a request of its own, with only its own
 * part of this state. Both questions go in one request here, so that a run sends TypeSafe one
 * request, and the answers come back in the same `answers` object either way.
 */
export const JEV_STATE: {
  readonly link: UrlDescription;
  readonly bookmark: CapturedEvidence;
} = {
  link: describeUrlForJudgment(new URL(CONTRACT_LINK), CONTRACT_TITLE, false),
  bookmark: { url: CONTRACT_LINK, title: CONTRACT_TITLE },
};

/**
 * The body of both Messages API requests: the prompt and the token limit of the gateway check
 * that "Deploys" in the plan describes, which got 15 input and 4 output tokens on 2026-10-24.
 */
export const MESSAGES_BODY = {
  max_tokens: 256,
  messages: [{ role: "user", content: "Reply with OK." }],
} as const;

/** Jev's answers to the sensitivity question and the `kind` question, in one request. */
export const JEV_CHECK: ContractCheck = {
  name: "Jev (the sensitivity and kind questions)",
  timeoutMs: JEV_ATTEMPT_TIMEOUT_MS,
  request(config) {
    return jevRequest(config, JEV_STATE, {
      [SENSITIVITY_ID]: SENSITIVITY_QUESTION,
      [KIND_ID]: KIND_QUESTION,
    });
  },
  parts: [
    { path: [], schema: SystemOneResponse },
    { path: ["answers", SENSITIVITY_ID], schema: NoulAnswer },
    { path: ["answers", KIND_ID], schema: KindAnswerSchema },
  ],
};

// The Messages API request through one adapter's transport, with MESSAGES_BODY.
function messagesRequest(
  transport: MessagesTransport,
  model: string,
): { readonly url: URL; readonly init: RequestInit } {
  const { url, headers } = messagesRequestTarget(transport, model);
  return {
    url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model, ...MESSAGES_BODY }),
      redirect: "manual",
    },
  };
}

/** The Messages API, straight to Anthropic, as the Anthropic adapter sends it. */
export const ANTHROPIC_CHECK: ContractCheck = {
  name: "Anthropic",
  timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS,
  request(config) {
    return messagesRequest(anthropicTransport(config), config.ANTHROPIC_MODEL);
  },
  parts: [{ path: [], schema: MessageResponse }],
};

/** The Messages API through the gateway's Anthropic endpoint, as the AI Gateway adapter sends it. */
export const AI_GATEWAY_CHECK: ContractCheck = {
  name: "Anthropic through AI Gateway",
  timeoutMs: ANTHROPIC_REQUEST_TIMEOUT_MS,
  request(config) {
    return messagesRequest(aiGatewayTransport(config), config.ANTHROPIC_MODEL);
  },
  parts: [{ path: [], schema: MessageResponse }],
};

// The repository CONTRACT_LINK names. matchGitHubRepository is the parser the enrichment module
// uses, so a link it stopped accepting would fail here, before anything is sent.
function contractRepository() {
  const match = matchGitHubRepository(CONTRACT_LINK);
  if (match === undefined) {
    throw new Error("CONTRACT_LINK isn't a GitHub repository");
  }
  return match;
}

/**
 * GitHub's "Get a repository", for Haystack's own repository. The client also reads the README,
 * as raw text that no schema checks, so that second request isn't sent.
 */
export const GITHUB_CHECK: ContractCheck = {
  name: "GitHub",
  timeoutMs: GITHUB_REQUEST_TIMEOUT_MS,
  request(config) {
    const { url, headers } = gitHubRepositoryRequest(config, contractRepository());
    return { url, init: { method: "GET", headers, redirect: "manual" } };
  },
  parts: [{ path: [], schema: RepositoryResponse }],
};

/**
 * Every check, in the order a run sends them: one request each, so a run sends four requests in
 * all: one each to TypeSafe, Anthropic, AI Gateway and GitHub.
 */
export const CONTRACT_CHECKS: readonly ContractCheck[] = [
  JEV_CHECK,
  ANTHROPIC_CHECK,
  AI_GATEWAY_CHECK,
  GITHUB_CHECK,
];
