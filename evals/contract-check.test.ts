// The contract check's own behaviour (#203): that each check passes an answer its client accepts,
// that a changed copy of a client's schema fails the matching check with the field's name, and
// that the report never prints a key. Every request is answered by a fake `fetch` from fixed
// answers in the shape of the clients' recorded fixtures (apps/worker/test), so nothing here
// reaches the network or needs a key. These tests run with `vp -C evals test`, and first in
// `vp -C evals run contract`, not in `vp test`.
import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import { MessageResponse } from "../apps/worker/src/enrichment/anthropic-messages.ts";
import { RepositoryResponse } from "../apps/worker/src/enrichment/github-client.ts";
import { NoulAnswer, SystemOneResponse } from "../apps/worker/src/enrichment/jev-client.ts";
import { KindAnswerSchema } from "../apps/worker/src/enrichment/jev-questions.ts";
import {
  AI_GATEWAY_CHECK,
  ANTHROPIC_CHECK,
  CONTRACT_CHECKS,
  CONTRACT_LINK,
  type ContractCheck,
  type ContractConfig,
  GITHUB_CHECK,
  JEV_CHECK,
  JEV_STATE,
  MESSAGES_BODY,
} from "./contract-checks.ts";
import { type ContractFetch, runContractCheck, runContractChecks } from "./contract-report.ts";

// Not real keys: strings that appear nowhere else, so finding one in the report is a leak.
const KEYS = {
  TYPESAFE_API_KEY: "ts-contract-key-5b1e9d",
  ANTHROPIC_API_KEY: "sk-ant-contract-key-8c4f2a",
  AI_GATEWAY_TOKEN: "aig-contract-token-3d7e61",
  GITHUB_TOKEN: "github_pat_contract_9a0b4c",
} as const;

const config: ContractConfig = {
  JEV_BASE_URL: "https://jev.test",
  JEV_MODEL: "jev-1.14.0",
  ANTHROPIC_BASE_URL: "https://api.anthropic.test",
  ANTHROPIC_MODEL: "claude-haiku-5-5",
  AI_GATEWAY_BASE_URL: "https://gateway.ai.cloudflare.test",
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "haystack-test",
  GITHUB_API_BASE_URL: "https://api.github.test",
  ...KEYS,
};

const KIND_PROBABILITIES = {
  tool: 0.81,
  library: 0.12,
  reference: 0.02,
  tutorial: 0.01,
  article: 0.01,
  discussion: 0.01,
  collection: 0.01,
  other: 0.01,
};

// Answers in the shape of jev-answers.ts, anthropic-fixture.ts and github-client.test.ts.
const JEV_ANSWER = {
  model: "jev-1.14.0",
  answers: {
    private_access: { type: "noul", noul: 0.03 },
    kind: { type: "choice", choice: "tool", confidence: 0.7, probabilities: KIND_PROBABILITIES },
  },
  usage: { input_tokens: 1067, output_tokens: 49 },
};

const MESSAGE = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "OK." }],
  stop_reason: "end_turn",
  stop_details: null,
  stop_sequence: null,
  usage: { input_tokens: 15, output_tokens: 4 },
};

const REPOSITORY = {
  name: "haystack",
  private: false,
  visibility: "public",
  description: "Bookmarks you can find again",
  language: "TypeScript",
  topics: ["bookmarks", "cloudflare-workers"],
};

/**
 * Each check, with the answer its client accepts, its client's root schema and a field of it, and
 * the client's schemas for the parts after the root, in the check's order.
 */
const CASES: readonly {
  readonly check: ContractCheck;
  readonly answer: object;
  readonly schema: v.ObjectSchema<v.ObjectEntries, undefined>;
  readonly field: string;
  readonly partSchemas: readonly v.GenericSchema[];
  // The key the request must carry, in the header the client sends it in.
  readonly keys: readonly (keyof typeof KEYS)[];
}[] = [
  {
    check: JEV_CHECK,
    answer: JEV_ANSWER,
    schema: SystemOneResponse,
    field: "usage",
    partSchemas: [NoulAnswer, KindAnswerSchema],
    keys: ["TYPESAFE_API_KEY"],
  },
  {
    check: ANTHROPIC_CHECK,
    answer: MESSAGE,
    schema: MessageResponse,
    field: "stop_reason",
    partSchemas: [],
    keys: ["ANTHROPIC_API_KEY"],
  },
  {
    check: AI_GATEWAY_CHECK,
    answer: MESSAGE,
    schema: MessageResponse,
    field: "stop_reason",
    partSchemas: [],
    keys: ["ANTHROPIC_API_KEY", "AI_GATEWAY_TOKEN"],
  },
  {
    check: GITHUB_CHECK,
    answer: REPOSITORY,
    schema: RepositoryResponse,
    field: "private",
    partSchemas: [],
    keys: ["GITHUB_TOKEN"],
  },
];

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A `fetch` that records each request and answers it with `answer`. */
function fakeFetch(answer: (request: SentRequest) => Response | Promise<Response>): {
  readonly fetcher: ContractFetch;
  readonly sent: SentRequest[];
} {
  const sent: SentRequest[] = [];
  const fetcher: ContractFetch = async (url, init) => {
    const request: SentRequest = {
      url: url.href,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? undefined,
    };
    sent.push(request);
    return answer(request);
  };
  return { fetcher, sent };
}

// The answer each request gets in a passing run, chosen by the request's address.
function passingAnswer(request: SentRequest): Response {
  if (request.url.includes("/systemone")) {
    return Response.json(JEV_ANSWER);
  }
  return Response.json(request.url.includes("/repos/") ? REPOSITORY : MESSAGE);
}

// A copy of `schema` in which `from` is called `to`, as if the client's schema had renamed it.
function renamed(
  schema: v.ObjectSchema<v.ObjectEntries, undefined>,
  from: string,
  to: string,
): v.GenericSchema {
  const { [from]: entry, ...entries } = schema.entries;
  if (entry === undefined) {
    throw new Error(`The schema has no ${from}`);
  }
  return v.object({ ...entries, [to]: entry });
}

describe("each check", () => {
  it.each(CASES)(
    "$check.name passes an answer its client accepts, with one request",
    async ({ check, answer, schema, partSchemas, keys }) => {
      // The check validates with the client's own schema objects, not copies of them. knip can't
      // show this, because each schema is also used in its own file.
      expect(check.parts.map(({ schema: partSchema }) => partSchema)).toHaveLength(
        1 + partSchemas.length,
      );
      expect(check.parts[0]?.schema).toBe(schema);
      partSchemas.forEach((partSchema, index) => {
        expect(check.parts[index + 1]?.schema).toBe(partSchema);
      });
      const { fetcher, sent } = fakeFetch(() => Response.json(answer));
      await expect(runContractCheck(check, config, fetcher)).resolves.toEqual({ result: "passed" });
      expect(sent).toHaveLength(1);
      // The key is in the request, so the tests below that look for it in the report have it.
      const headers = [...(sent[0]?.headers.values() ?? [])].join("\n");
      for (const key of keys) {
        expect(headers).toContain(KEYS[key]);
      }
    },
  );

  it.each(CASES)(
    "$check.name fails, naming the field, when the client's schema renames $field",
    async ({ check, answer, schema, field }) => {
      const changed: ContractCheck = {
        ...check,
        parts: [
          { path: [], schema: renamed(schema, field, `${field}_renamed`) },
          ...check.parts.slice(1),
        ],
      };
      const { fetcher } = fakeFetch(() => Response.json(answer));
      const lines: string[] = [];
      await runContractChecks([changed], config, fetcher, (line) => lines.push(line));
      expect(lines).toEqual([`${check.name}: failed, ${field}_renamed didn't validate`]);
    },
  );

  it.each(CASES)("$check.name sends nothing without its key", async ({ check, keys }) => {
    const { fetcher, sent } = fakeFetch(() => Response.json({}));
    const [key] = keys;
    if (key === undefined) {
      throw new Error("Each check needs a key");
    }
    await expect(runContractCheck(check, { ...config, [key]: "" }, fetcher)).resolves.toEqual({
      result: "not-sent",
      code: `${key}_EMPTY`,
    });
    expect(sent).toHaveLength(0);
  });
});

describe("the Jev check", () => {
  it("names the answer's field when Jev renames it", async () => {
    const answer = {
      ...JEV_ANSWER,
      answers: { ...JEV_ANSWER.answers, private_access: { type: "noul", probability: 0.03 } },
    };
    const { fetcher } = fakeFetch(() => Response.json(answer));
    await expect(runContractCheck(JEV_CHECK, config, fetcher)).resolves.toEqual({
      result: "invalid",
      field: "answers.private_access.noul",
    });
  });

  it("names the missing answer", async () => {
    const answer = {
      ...JEV_ANSWER,
      answers: { private_access: JEV_ANSWER.answers.private_access },
    };
    const { fetcher } = fakeFetch(() => Response.json(answer));
    await expect(runContractCheck(JEV_CHECK, config, fetcher)).resolves.toEqual({
      result: "invalid",
      field: "answers.kind",
    });
  });

  it("names the probabilities when they leave out a kind", async () => {
    const { other: _, ...probabilities } = KIND_PROBABILITIES;
    const answer = {
      ...JEV_ANSWER,
      answers: { ...JEV_ANSWER.answers, kind: { ...JEV_ANSWER.answers.kind, probabilities } },
    };
    const { fetcher } = fakeFetch(() => Response.json(answer));
    await expect(runContractCheck(JEV_CHECK, config, fetcher)).resolves.toEqual({
      result: "invalid",
      field: "answers.kind.probabilities",
    });
  });

  it("names the probabilities, not a key Jev sent in them", async () => {
    // A key of `probabilities` comes from the response, so it could be anything, a key included.
    const probabilities = { ...KIND_PROBABILITIES, [KEYS.TYPESAFE_API_KEY]: 2 };
    const answer = {
      ...JEV_ANSWER,
      answers: { ...JEV_ANSWER.answers, kind: { ...JEV_ANSWER.answers.kind, probabilities } },
    };
    const { fetcher } = fakeFetch(() => Response.json(answer));
    const lines: string[] = [];
    await runContractChecks([JEV_CHECK], config, fetcher, (line) => lines.push(line));
    expect(lines).toEqual([
      `${JEV_CHECK.name}: failed, answers.kind.probabilities didn't validate`,
    ]);
  });
});

describe("the requests", () => {
  it("send fixed bodies, which name only Haystack's own repository", async () => {
    const { fetcher, sent } = fakeFetch(passingAnswer);
    await runContractChecks(CONTRACT_CHECKS, config, fetcher, () => {});
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST https://jev.test/v1/systemone",
      "POST https://api.anthropic.test/v1/messages",
      `POST https://gateway.ai.cloudflare.test/v1/${config.AI_GATEWAY_ACCOUNT_ID}/${config.AI_GATEWAY_ID}/anthropic/v1/messages`,
      "GET https://api.github.test/repos/schalkneethling/haystack",
    ]);
    const [jev, anthropic, gateway, github] = sent;
    expect(JSON.parse(jev?.body ?? "")).toEqual({
      model: config.JEV_MODEL,
      state: JEV_STATE,
      questions: {
        private_access: expect.objectContaining({ type: "noul" }),
        kind: expect.objectContaining({ type: "choice" }),
      },
    });
    // The sensitivity question sees the link's description only, as in production.
    expect(JSON.stringify(JEV_STATE.link)).not.toContain(CONTRACT_LINK);
    for (const request of [anthropic, gateway]) {
      expect(JSON.parse(request?.body ?? "")).toEqual({
        model: config.ANTHROPIC_MODEL,
        ...MESSAGES_BODY,
      });
    }
    expect(github?.body).toBeUndefined();
  });

  it("send the gateway's headers, so the gateway logs no bodies", async () => {
    const { fetcher, sent } = fakeFetch(() => Response.json(MESSAGE));
    await runContractCheck(AI_GATEWAY_CHECK, config, fetcher);
    expect(sent[0]?.headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(sent[0]?.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent[0]?.headers.get("cf-aig-no-wholesale")).toBe("true");
  });
});

// The first field of each client's root schema that a 200 of strings fails. Jev's and
// Anthropic's `model` is a string, so it passes.
const FIRST_INVALID: Readonly<Record<string, string>> = {
  [JEV_CHECK.name]: "answers",
  [ANTHROPIC_CHECK.name]: "stop_details",
  [AI_GATEWAY_CHECK.name]: "stop_details",
  [GITHUB_CHECK.name]: "private",
};

describe("the report", () => {
  // Each answer holds every key, in a body, an error message or a header, as a service that
  // echoed what it was sent might.
  const echo = Object.values(KEYS).join(" ");
  const failures: readonly {
    readonly name: string;
    readonly answer: () => Response;
    readonly line: (check: ContractCheck) => string;
  }[] = [
    {
      name: "a 200 whose fields don't validate",
      answer: () =>
        Response.json({
          model: echo,
          answers: echo,
          usage: echo,
          stop_reason: echo,
          stop_details: echo,
          content: echo,
          private: echo,
          description: echo,
          language: echo,
        }),
      line: ({ name }) => `${name}: failed, ${FIRST_INVALID[name]} didn't validate`,
    },
    {
      name: "a 401 that repeats the key",
      answer: () => Response.json({ error: { message: `Invalid key ${echo}` } }, { status: 401 }),
      line: ({ name }) => `${name}: failed, HTTP 401`,
    },
    {
      name: "a 200 that isn't JSON",
      answer: () => new Response(`<p>${echo}</p>`, { headers: { "x-echo": echo } }),
      line: ({ name }) => `${name}: failed, the response isn't JSON`,
    },
    {
      name: "a network error whose message has the key",
      answer: () => {
        throw new TypeError(`fetch failed for ${echo}`);
      },
      line: ({ name }) => `${name}: failed, network error`,
    },
  ];

  it.each(failures)("holds no key for $name", async ({ answer, line }) => {
    const { fetcher, sent } = fakeFetch(answer);
    const lines: string[] = [];
    const passed = await runContractChecks(CONTRACT_CHECKS, config, fetcher, (written) =>
      lines.push(written),
    );
    expect(passed).toBe(false);
    expect(sent).toHaveLength(CONTRACT_CHECKS.length);
    expect(lines).toEqual(CONTRACT_CHECKS.map(line));
    const report = lines.join("\n");
    for (const key of Object.values(KEYS)) {
      expect(report).not.toContain(key);
    }
  });

  it("holds no key for a passing run", async () => {
    const { fetcher } = fakeFetch(passingAnswer);
    const lines: string[] = [];
    await expect(
      runContractChecks(CONTRACT_CHECKS, config, fetcher, (line) => lines.push(line)),
    ).resolves.toBe(true);
    expect(lines).toEqual(CONTRACT_CHECKS.map((check) => `${check.name}: passed`));
    for (const key of Object.values(KEYS)) {
      expect(lines.join("\n")).not.toContain(key);
    }
  });

  it("names an unexpected error by its name, never its message", async () => {
    const check: ContractCheck = {
      ...GITHUB_CHECK,
      request() {
        throw new TypeError(`Couldn't build the request with ${KEYS.GITHUB_TOKEN}`);
      },
    };
    const { fetcher, sent } = fakeFetch(passingAnswer);
    const lines: string[] = [];
    await runContractChecks([check], config, fetcher, (line) => lines.push(line));
    expect(lines).toEqual(["GitHub: not sent, UNEXPECTED_ERROR (TypeError)"]);
    expect(sent).toHaveLength(0);
  });

  it("leaves out an unexpected error's name when it isn't a plain name", async () => {
    const check: ContractCheck = {
      ...GITHUB_CHECK,
      request() {
        throw Object.assign(new Error("Couldn't build the request"), {
          name: `Error ${KEYS.GITHUB_TOKEN}`,
        });
      },
    };
    const { fetcher } = fakeFetch(passingAnswer);
    const lines: string[] = [];
    await runContractChecks([check], config, fetcher, (line) => lines.push(line));
    expect(lines).toEqual(["GitHub: not sent, UNEXPECTED_ERROR"]);
  });

  it("reports a request past its time limit", async () => {
    const check: ContractCheck = { ...GITHUB_CHECK, timeoutMs: 20 };
    const { fetcher } = fakeFetch(
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
        }),
    );
    const lines: string[] = [];
    await runContractChecks([check], config, fetcher, (line) => lines.push(line));
    expect(lines).toEqual(["GitHub: failed, no answer within 0.02 s"]);
  });
});
