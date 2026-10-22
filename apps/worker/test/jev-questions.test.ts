// The two questions enrichment asks Jev (#122): the sensitivity check and the `kind` question.
// Every request is answered by the Jev fixture (jev-fixture.ts). See "Probabilistic check with
// Jev" and "Jev ingestion questions" in plans/haystack-v1-implementation-plan.md.
import { describeUrlForJudgment } from "@haystack/schemas";
import type { JsonBodyType } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { JevConfig, JevTiming } from "../src/enrichment/jev-client.ts";
import {
  askKind,
  askSensitivity,
  KIND_QUESTION,
  type KindEvidence,
  KINDS,
} from "../src/enrichment/jev-questions.ts";
import { answer, JEV_ORIGIN, type JevFixture, startJevFixture } from "./jev-fixture.ts";

const config: JevConfig = {
  JEV_BASE_URL: JEV_ORIGIN,
  JEV_MODEL: "jev-1.13.0",
  TYPESAFE_API_KEY: "ts-test-key-7f3a9c1e",
};

const timing: JevTiming = { attemptTimeoutMs: 100, backoffInitialMs: 1 };

let fixture: JevFixture;

beforeAll(() => {
  fixture = startJevFixture();
});

afterAll(() => {
  fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

afterEach(() => {
  expect(fixture.unplanned).toEqual([]);
});

// The body of the only request the fixture received.
function sentBody(): { model: string; state: unknown; questions: Record<string, unknown> } {
  expect(fixture.requests).toHaveLength(1);
  return JSON.parse(fixture.requests[0]?.body ?? "");
}

describe("askSensitivity", () => {
  // A private document share: the document's id and the token are what make it a key.
  const documentId = "1aBcD9xQzLmNoPqRsTuVwXyZ0123456789abcdEFGH";
  const token = "Zx81kQ2mPa9wLr4T";
  const url = new URL(
    `https://docs.google.com/document/d/${documentId}/edit?usp=sharing&token=${token}`,
  );
  const title = "Q3 planning (draft) - Google Docs";
  const description = describeUrlForJudgment(url, title, true);

  const response = {
    model: "jev-1.13.0",
    answers: { private_access: { type: "noul", noul: 0.93 } },
    usage: { input_tokens: 412, output_tokens: 9 },
  };

  it("returns the probability that the link gives private access", async () => {
    fixture.respond(answer(response));
    expect(await askSensitivity(config, description, timing)).toEqual({
      ok: true,
      answer: 0.93,
      model: "jev-1.13.0",
      inputTokens: 412,
      attempts: 1,
    });
  });

  it("sends describeUrlForJudgment's output and not the URL", async () => {
    fixture.respond(answer(response));
    await askSensitivity(config, description, timing);
    const body = sentBody();
    expect(body.model).toBe("jev-1.13.0");
    expect(body.state).toEqual({ link: description });
    expect(Object.keys(body.questions)).toEqual(["private_access"]);
    expect(body.questions.private_access).toMatchObject({ type: "noul" });
    // Neither the URL nor any of its values is anywhere in what was sent.
    const sent = fixture.requests[0]?.body ?? "";
    for (const secret of [url.href, url.search, documentId, token, "sharing"]) {
      expect(sent).not.toContain(secret);
    }
  });
});

describe("askKind", () => {
  const evidence: KindEvidence = {
    bookmark: {
      url: "https://github.com/vitest-dev/vitest",
      title: "Vitest",
      description: "Next generation testing framework powered by Vite.",
      og_site_name: "GitHub",
    },
    github: {
      repository: "vitest-dev/vitest",
      description: "Next generation testing framework powered by Vite.",
    },
  };

  const probabilities = {
    tool: 0.81,
    library: 0.12,
    reference: 0.02,
    tutorial: 0.01,
    article: 0.01,
    discussion: 0.01,
    collection: 0.01,
    other: 0.01,
  };

  function kindResponse(kindAnswer: JsonBodyType) {
    return {
      model: "jev-1.13.0",
      answers: { kind: kindAnswer },
      usage: { input_tokens: 655, output_tokens: 40 },
    };
  }

  it("returns the chosen kind and its full distribution", async () => {
    fixture.respond(
      answer(kindResponse({ type: "choice", choice: "tool", confidence: 0.7, probabilities })),
    );
    expect(await askKind(config, evidence, timing)).toEqual({
      ok: true,
      answer: { kind: "tool", probabilities },
      model: "jev-1.13.0",
      inputTokens: 655,
      attempts: 1,
    });
  });

  it("sends the evidence as the state, with every kind as an option", async () => {
    fixture.respond(
      answer(kindResponse({ type: "choice", choice: "tool", confidence: 0.7, probabilities })),
    );
    await askKind(config, evidence, timing);
    const body = sentBody();
    expect(body.state).toEqual(evidence);
    expect(body.questions).toEqual({ kind: KIND_QUESTION });
    expect(Object.keys(KIND_QUESTION.criteria)).toEqual([...KINDS]);
  });

  it("always offers other, last, and describes every option", () => {
    expect(KINDS.at(-1)).toBe("other");
    for (const kind of KINDS) {
      expect(KIND_QUESTION.criteria[kind]).toMatch(/\S/);
    }
  });

  const invalid: [string, JsonBodyType][] = [
    ["a choice that isn't an option", { type: "choice", choice: "repository", probabilities }],
    [
      "a distribution without every option",
      { type: "choice", choice: "tool", probabilities: { tool: 0.9, other: 0.1 } },
    ],
    [
      "a distribution with an option that wasn't offered",
      { type: "choice", choice: "tool", probabilities: { ...probabilities, repository: 0 } },
    ],
  ];
  for (const [name, kindAnswer] of invalid) {
    it(`makes ${name} a permanent failure`, async () => {
      fixture.respond(answer(kindResponse(kindAnswer)));
      expect(await askKind(config, evidence, timing)).toEqual({
        ok: false,
        failure: "permanent",
        reason: "invalid-response",
        attempts: 1,
      });
    });
  }
});
