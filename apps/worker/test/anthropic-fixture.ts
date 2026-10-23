// The Claude API for the Anthropic adapter's tests (#124), in the style of jev-fixture.ts. Tests
// make no requests to the internet: Mock Service Worker (MSW) patches `globalThis.fetch` in the
// test's own process, and answers the adapter's requests at ANTHROPIC_ORIGIN, under the reserved
// `.test` domain, so no name is ever looked up.
//
// A test queues one resolver for each request it expects, in order. Any other request is one no
// test planned for: a request beyond the queue, to another path, or to any other address, such
// as a redirect's target. The fixture records its address in `unplanned`, which the tests check,
// and MSW fails it (`onUnhandledFrame: "error"`), so it never reaches the network.
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";

/** The address the tests configure as ANTHROPIC_BASE_URL. */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.test";

/** The endpoint the adapter posts every request to. */
export const MESSAGES_URL = `${ANTHROPIC_ORIGIN}/v1/messages`;

/**
 * The same endpoint on a loopback host over http, as the integration tests' recorded server
 * serves it (see "Testing strategy" in the plan). MSW answers it too, so nothing listens there.
 */
export const LOOPBACK_ORIGIN = "http://127.0.0.1:8788";

/** A request the fixture answered, as Anthropic would see it. */
export interface AnthropicRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The body as sent. */
  readonly body: string;
}

export type AnthropicResolver = (request: Request) => Response | Promise<Response>;

export interface AnthropicFixture {
  /** Every request to the endpoint since the fixture started or was last reset, in order. */
  readonly requests: readonly AnthropicRequest[];
  /** Requests no test planned for. */
  readonly unplanned: readonly string[];
  /** Answers the next requests to the endpoint, one resolver each, in order. */
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
 * Starts answering the adapter's requests in this process. Only one may run at a time, because
 * it patches the process's `fetch`.
 */
export function startAnthropicFixture(): AnthropicFixture {
  const queue: AnthropicResolver[] = [];
  const requests: AnthropicRequest[] = [];
  const unplanned: string[] = [];
  const answerNext = async ({ request }: { request: Request }) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
    });
    const resolver = queue.shift();
    if (resolver === undefined) {
      unplanned.push(request.url);
      return HttpResponse.error();
    }
    return resolver(request);
  };
  const mock = setupServer(
    http.post(MESSAGES_URL, answerNext),
    http.post(`${LOOPBACK_ORIGIN}/v1/messages`, answerNext),
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
