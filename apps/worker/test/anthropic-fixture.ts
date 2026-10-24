// The Claude API for the Anthropic adapter's tests (#124), and Cloudflare AI Gateway's Anthropic
// endpoint for the AI Gateway adapter's (#125), in the style of jev-fixture.ts. Tests make no
// requests to the internet: Mock Service Worker (MSW) patches `globalThis.fetch` in the test's own
// process, and answers the adapters' requests at ANTHROPIC_ORIGIN and GATEWAY_ORIGIN, under the
// reserved `.test` domain, so no name is ever looked up. Both endpoints take the same request and
// answer with the same Message, so one queue of resolvers answers both.
//
// A test queues one resolver for each request it expects, in order. Any other request is one no
// test planned for: a request beyond the queue, to another path, or to any other address, such
// as a redirect's target. The fixture records its address in `unplanned`, which the tests check,
// and MSW fails it (`onUnhandledFrame: "error"`), so it never reaches the network.
//
// A request to the gateway without `cf-aig-collect-log-payload: false` is unplanned too, whatever
// the queue holds, because the gateway would log its prompt and its response (Q7). So is one
// without the Anthropic key in `x-api-key`, or with an `authorization` header, because the real
// gateway answered a key in `authorization` with a 400 on 2026-10-24 (ai-gateway-provider.ts).
// So every test that sends such a request through the gateway fails, the validation retry's
// included.
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";

/** The address the tests configure as ANTHROPIC_BASE_URL. */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.test";

/** The endpoint the Anthropic adapter posts every request to. */
export const MESSAGES_URL = `${ANTHROPIC_ORIGIN}/v1/messages`;

/**
 * Both endpoints on a loopback host over http, as the integration tests' recorded server serves
 * them (see "Testing strategy" in the plan). MSW answers them too, so nothing listens there.
 */
export const LOOPBACK_ORIGIN = "http://127.0.0.1:8788";

/** The IDs the tests configure as AI_GATEWAY_ACCOUNT_ID and AI_GATEWAY_ID. */
export const GATEWAY_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const GATEWAY_ID = "haystack-test";

/** The address the tests configure as AI_GATEWAY_BASE_URL. */
export const GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.test";

/** The path of the gateway's Anthropic endpoint, Anthropic's `/v1/messages` under the gateway's. */
export const GATEWAY_PATH = `/v1/${GATEWAY_ACCOUNT_ID}/${GATEWAY_ID}/anthropic/v1/messages`;

/** The endpoint the AI Gateway adapter posts every request to. */
export const GATEWAY_MESSAGES_URL = `${GATEWAY_ORIGIN}${GATEWAY_PATH}`;

/** A request the fixture answered, as Anthropic or the gateway would see it. */
export interface AnthropicRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The body as sent. */
  readonly body: string;
}

export type AnthropicResolver = (request: Request) => Response | Promise<Response>;

export interface AnthropicFixture {
  /** Every request to either endpoint since the fixture started or was last reset, in order. */
  readonly requests: readonly AnthropicRequest[];
  /** Requests no test planned for. */
  readonly unplanned: readonly string[];
  /** Answers the next requests to either endpoint, one resolver each, in order. */
  respond(...resolvers: AnthropicResolver[]): void;
  /** Forgets the queued resolvers and the requests. */
  reset(): void;
  /** Stops answering, and restores `globalThis.fetch`. */
  close(): void;
}

/**
 * A Message in the shape the Messages API reference documents, as Claude Haiku 5.5 answers with
 * structured output: a thinking block, whose text is omitted by default, then a text block with
 * the JSON.
 */
export function messageBody(
  text: string,
  stopReason = "end_turn",
): { [key: string]: JsonBodyType } {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "fixture-signature" },
      { type: "text", text },
    ],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 812, output_tokens: 164 },
  };
}

/** A 200 response whose text is this output, as JSON. */
export function output(value: JsonBodyType): AnthropicResolver {
  return () => HttpResponse.json(messageBody(JSON.stringify(value)));
}

/** A 200 response with this body, as JSON. */
export function answer(body: JsonBodyType): AnthropicResolver {
  return () => HttpResponse.json(body);
}

/** A response with this status and an error body in the shape the errors page documents. */
export function status(code: number, headers: Record<string, string> = {}): AnthropicResolver {
  return () =>
    HttpResponse.json(
      {
        type: "error",
        error: { type: "fixture_error", message: "fixture error" },
        request_id: "req_fixture",
      },
      { status: code, headers },
    );
}

/** A request that fails without a response, as a refused connection does. */
export const networkError: AnthropicResolver = () => HttpResponse.error();

/**
 * Starts answering the adapters' requests in this process. Only one may run at a time, because
 * it patches the process's `fetch`.
 */
export function startAnthropicFixture(): AnthropicFixture {
  const queue: AnthropicResolver[] = [];
  const requests: AnthropicRequest[] = [];
  const unplanned: string[] = [];
  const record = async (request: Request) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
    });
  };
  const answerNext = (request: Request) => {
    const resolver = queue.shift();
    if (resolver === undefined) {
      unplanned.push(request.url);
      return HttpResponse.error();
    }
    return resolver(request);
  };
  const answerAnthropic = async ({ request }: { request: Request }) => {
    await record(request);
    return answerNext(request);
  };
  const answerGateway = async ({ request }: { request: Request }) => {
    await record(request);
    if (request.headers.get("cf-aig-collect-log-payload") !== "false") {
      unplanned.push(`${request.url} without cf-aig-collect-log-payload: false`);
      return HttpResponse.error();
    }
    if (!request.headers.has("x-api-key") || request.headers.has("authorization")) {
      unplanned.push(`${request.url} without the key in x-api-key alone`);
      return HttpResponse.error();
    }
    return answerNext(request);
  };
  const mock = setupServer(
    http.post(MESSAGES_URL, answerAnthropic),
    http.post(`${LOOPBACK_ORIGIN}/v1/messages`, answerAnthropic),
    http.post(GATEWAY_MESSAGES_URL, answerGateway),
    http.post(`${LOOPBACK_ORIGIN}${GATEWAY_PATH}`, answerGateway),
  );
  mock.events.on("request:unhandled", ({ request }) => {
    unplanned.push(request.url);
  });
  mock.listen({ onUnhandledFrame: "error" });
  return {
    requests,
    unplanned,
    respond: (...resolvers) => {
      queue.push(...resolvers);
    },
    reset: () => {
      queue.length = 0;
      requests.length = 0;
      unplanned.length = 0;
    },
    close: () => {
      mock.close();
    },
  };
}
