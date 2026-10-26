// A local stand-in for every service the enrichment sweep calls (#128): Jev, the LLM (the Claude
// API and Cloudflare AI Gateway's Anthropic endpoint) and GitHub. Phase 8's acceptance runs the
// sweep under `wrangler dev --test-scheduled` against it, so a backlog of local fixture
// bookmarks can be drained without real keys and without any request leaving this machine. See
// "Enrichment sweep" in plans/haystack-v1-implementation-plan.md, which has the commands.
//
// It isn't part of the Worker: nothing in src/ imports it. Run it with
// `vp -C apps/worker run fixtures`, then point the base URLs at it, which the clients accept
// because it is plain http on a loopback host (checkedBaseUrl). It needs Node 22.18 or later, for
// type stripping and `import.meta.main`. The repository pins no Node version: Vite+ resolves the
// current LTS, and CI asks setup-vp for Node 24.
//
// It answers what the clients accept, built from their requests rather than recorded:
// - Jev: each question in the request gets an answer of its type. A Noul question gets 0.05, so
//   no bookmark is Held. A Choice question picks one of the request's own options, the same one
//   for the same state, with a probability for every option, as the client's schema requires.
// - The LLM: a Message whose one text block is an output that EnrichmentV1 accepts.
// - GitHub: a public repository, and a short README.
// Each checks the headers its service would need, such as the gateway's
// `cf-aig-collect-log-payload: false`, and answers anything else with a 404 that it logs, so a
// request the clients shouldn't make shows up in the output. It logs each request's method,
// path and status, never a header or a body.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

/** The port the server listens on unless `--port` gives another. */
export const FIXTURE_SERVER_PORT = 8789;

/** The noul every sensitivity question gets: well below the threshold, so nothing is Held. */
const NOUL = 0.05;

/** The output every LLM request gets, within EnrichmentV1's caps. */
const ENRICHMENT_OUTPUT = {
  summary: "A page saved in a local fixture backlog, enriched by Haystack's fixture server.",
  use_cases: ["Use when you need to check that the enrichment sweep drains a backlog."],
  problems_solved: ["Running the sweep locally without real keys."],
  technologies: ["Cloudflare Workers"],
  topics: ["local development", "fixtures"],
  alternative_terms: ["fixture enrichment"],
};

type Answer = { readonly status: number; readonly type: string; readonly body: string };

function json(body: unknown, status = 200): Answer {
  return { status, type: "application/json", body: JSON.stringify(body) };
}

const NOT_FOUND = json({ message: "The fixture server has no answer for this request" }, 404);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A header sent once, or undefined. A header sent twice isn't one any client here sends.
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function isBearer(value: string | undefined): boolean {
  return value !== undefined && value.startsWith("Bearer ") && value.length > "Bearer ".length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A Choice answer over the question's own options. The pick depends only on the state, so the
// same bookmark gets the same kind each time.
function choiceAnswer(state: unknown, options: string[]): unknown {
  const digest = createHash("sha256").update(JSON.stringify(state)).digest();
  const choice = options[digest.readUInt32BE(0) % options.length]!;
  const rest = options.length > 1 ? 0.4 / (options.length - 1) : 0;
  const probabilities = Object.fromEntries(
    options.map((option) => [option, option === choice ? (options.length > 1 ? 0.6 : 1) : rest]),
  );
  return { type: "choice", choice, confidence: 0.6, probabilities };
}

// TypeSafe's System One endpoint: one answer for each question, by its type.
function answerJev(request: IncomingMessage, body: string): Answer {
  const parsed = parseJson(body);
  if (
    !isBearer(header(request, "authorization")) ||
    !isRecord(parsed) ||
    !isRecord(parsed.questions)
  ) {
    return NOT_FOUND;
  }
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(parsed.questions)) {
    if (isRecord(question) && question.type === "noul") {
      answers[id] = { type: "noul", noul: NOUL };
    } else if (isRecord(question) && question.type === "choice" && isRecord(question.criteria)) {
      answers[id] = choiceAnswer(parsed.state, Object.keys(question.criteria));
    } else {
      return NOT_FOUND;
    }
  }
  return json({
    model: typeof parsed.model === "string" ? parsed.model : "jev-fixture",
    answers,
    usage: { input_tokens: body.length, output_tokens: 12 },
  });
}

// The Messages API, at Anthropic's path and at the gateway's. Anthropic takes its key in
// `authorization` or `x-api-key`. The gateway takes it only in `x-api-key`, and answers one in
// `authorization` with a 400, so that is refused here too. The gateway's request must also carry
// its own token in `cf-aig-authorization`, and `cf-aig-collect-log-payload: false`, which keeps
// the prompt out of its logs (Q7). The rules are the adapters' (anthropic-provider.ts and
// ai-gateway-provider.ts).
function hasKey(request: IncomingMessage, gateway: boolean): boolean {
  const authorization = header(request, "authorization");
  const apiKey = header(request, "x-api-key");
  if (!gateway) {
    return isBearer(authorization) || Boolean(apiKey);
  }
  return (
    Boolean(apiKey) &&
    request.headers.authorization === undefined &&
    isBearer(header(request, "cf-aig-authorization")) &&
    header(request, "cf-aig-collect-log-payload") === "false"
  );
}

function answerMessages(request: IncomingMessage, body: string, gateway: boolean): Answer {
  const parsed = parseJson(body);
  if (!hasKey(request, gateway) || !isRecord(parsed)) {
    return NOT_FOUND;
  }
  return json({
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: typeof parsed.model === "string" ? parsed.model : "claude-fixture",
    content: [
      { type: "thinking", thinking: "", signature: "fixture-signature" },
      { type: "text", text: JSON.stringify(ENRICHMENT_OUTPUT) },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: body.length, output_tokens: 120 },
  });
}

// GitHub's repository and README, for any repository path.
function answerGitHub(
  request: IncomingMessage,
  owner: string,
  repo: string,
  readme: boolean,
): Answer {
  if (!isBearer(header(request, "authorization"))) {
    return NOT_FOUND;
  }
  if (readme) {
    return {
      status: 200,
      type: "application/vnd.github.raw+json; charset=utf-8",
      body: `# ${repo}\n\nA fixture repository by ${owner}, served by Haystack's fixture server.\n`,
    };
  }
  return json({
    private: false,
    visibility: "public",
    description: `The ${repo} fixture repository.`,
    language: "TypeScript",
    topics: ["fixture"],
  });
}

const GATEWAY_MESSAGES = /^\/v1\/[^/]+\/[^/]+\/anthropic\/v1\/messages$/;
const REPOSITORY = /^\/repos\/([^/]+)\/([^/]+?)(\/readme)?$/;

async function answer(request: IncomingMessage, path: string): Promise<Answer> {
  const body = await readBody(request);
  if (request.method === "POST" && path === "/v1/systemone") {
    return answerJev(request, body);
  }
  if (request.method === "POST" && path === "/v1/messages") {
    return answerMessages(request, body, false);
  }
  if (request.method === "POST" && GATEWAY_MESSAGES.test(path)) {
    return answerMessages(request, body, true);
  }
  const repository = request.method === "GET" ? REPOSITORY.exec(path) : null;
  if (repository !== null) {
    const [, owner, repo, readme] = repository;
    return answerGitHub(request, owner!, repo!, readme !== undefined);
  }
  return NOT_FOUND;
}

/**
 * The fixture server, not yet listening. `log` gets one line for each request: its method, its
 * path and the status it was answered with.
 */
export function createFixtureServer(log: (line: string) => void = console.info): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    void answer(request, path)
      // A body that stops arriving, the only way answer() can fail.
      .catch(() => json({ message: "The fixture server couldn't read the request" }, 500))
      .then(({ status, type, body }) => {
        log(`${request.method} ${path} ${status}${status === 404 ? " (unplanned)" : ""}`);
        response.writeHead(status, { "content-type": type });
        response.end(body);
      });
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: String(FIXTURE_SERVER_PORT) } },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port is ${JSON.stringify(values.port)}, which isn't a port from 1 to 65535`);
    process.exit(1);
  }
  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    const origin = `http://127.0.0.1:${port}`;
    console.info(`Fixture server for Jev, the LLM and GitHub at ${origin}`);
    console.info(
      `Base URLs: JEV_BASE_URL, ANTHROPIC_BASE_URL, AI_GATEWAY_BASE_URL and GITHUB_API_BASE_URL=${origin}`,
    );
  });
  const stop = () => {
    server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
