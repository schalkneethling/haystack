// The two questions enrichment asks Jev (#122). See "Probabilistic check with Jev" and "Jev
// ingestion questions" in plans/haystack-v1-implementation-plan.md, which record why each is
// worded as it is. The wording follows TypeSafe's Noul and Choice pages
// (https://docs.typesafe.ai/primitives/noul.md, https://docs.typesafe.ai/primitives/choice.md):
// a question names the part of the state it is about with a backticked path, a Noul's high value
// means yes, and each Choice option has a description that tells it apart from the others.
//
// The questions are asked in two requests, not one, because the `kind` question's state may only
// be sent once the sensitivity answer allows it, and it includes GitHub's data, which is fetched
// only after that.
import type { UrlDescription } from "@haystack/schemas";
import {
  askJev,
  type ChoiceQuestion,
  choiceAnswer,
  JEV_TIMING,
  type JevConfig,
  type JevResult,
  type JevTiming,
  NoulAnswer,
  type NoulQuestion,
} from "./jev-client.ts";

/**
 * Would this link give access to something private? The state is `{ link }`, where `link` is
 * describeUrlForJudgment's output, so the URL itself is never sent. The instructions say what the
 * placeholders mean, because Jev reads the question literally and has no other way to know.
 */
export const SENSITIVITY_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: {
    question:
      "Would the web address that `link` describes give anyone who has it access to something private, such as a document, a file, an account or an invitation?",
    about_link:
      "`link` describes the address without its values. Each query value, each fragment value and each part of the address that does not read as words is replaced by a placeholder: `<empty>`, or `<class:length>`, where the class is digits, word, hex or random, and the length counts its characters. `link.title`, when present, is the page's title. `link.declares_sensitive_canonical` is present, and true, when the page named a canonical address that Haystack recognized as carrying a secret.",
  },
  criteria: {
    true: "The address works as a key: whoever has it gets in without signing in, as with a shared document or file, a signed download link, an invitation, a sign-in or password reset link, or an address that carries an access token. `link.declares_sensitive_canonical` is a strong sign of this.",
    false:
      "The address leads to a public page, such as an article, documentation, a product page, a search or a repository, which anyone can open without the address being shared with them.",
  },
};

/** Asks whether the described link gives access to something private, as a probability. */
export function askSensitivity(
  config: JevConfig,
  description: UrlDescription,
  timing: JevTiming = JEV_TIMING,
): Promise<JevResult<number>> {
  return askJev(
    config,
    {
      state: { link: description },
      id: "private_access",
      question: SENSITIVITY_QUESTION,
      answer: NoulAnswer,
    },
    timing,
  );
}

/**
 * What a bookmark is, judged by what a person does with it, and not where it is hosted: a
 * repository of a test runner is a `tool`, and its host is already in the URL. `other` comes
 * last, because Jev 1.13 leans toward the first option when options compete.
 */
export const KINDS = [
  "tool",
  "library",
  "reference",
  "tutorial",
  "article",
  "discussion",
  "collection",
  "other",
] as const;

export type Kind = (typeof KINDS)[number];

export const KIND_QUESTION: ChoiceQuestion<Kind> = {
  type: "choice",
  instructions: {
    question:
      "What kind of resource is the page that `bookmark` describes, judged by what a person does with it?",
    context:
      "When `github` is present, it describes the GitHub repository the page belongs to. The page may be the repository itself or a page inside it, such as an issue or a file, and the answer is the kind of the page.",
  },
  criteria: {
    tool: "Software a person uses to get a task done: an app, a web service, a command-line program, a browser extension or a developer tool.",
    library:
      "Code a developer builds into their own software: a package, a framework, an SDK, a plugin or a component library.",
    reference:
      "Material a person looks things up in again and again, rather than reads through once: documentation, an API reference, a specification, a cheat sheet or a glossary.",
    tutorial:
      "Teaches how to do a task, step by step: a guide, a how-to, a course or a walkthrough, written or on video.",
    article:
      "Explains, reports or argues something, without teaching a task step by step: a blog post, an essay, a news story, an announcement, a talk or a podcast episode.",
    discussion:
      "A conversation between people: a forum thread, a question and its answers, an issue or a pull request, or a social media post.",
    collection:
      "A curated list of other resources: an awesome list, a directory, a link roundup or a reading list.",
    other:
      "Anything the other options don't describe, such as a dataset, a shop's product page or a personal homepage.",
  },
};

/**
 * What the bookmark says about the page, from its row. A key is absent when the bookmark has no
 * value for it. `title` and `description` are what the user confirmed on the save form, and the
 * `captured_` and `og_` values are what the page said about itself.
 */
export interface CapturedEvidence {
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly canonical_url?: string;
  readonly captured_title?: string;
  readonly captured_description?: string;
  readonly og_title?: string;
  readonly og_description?: string;
  readonly og_site_name?: string;
}

/** The `kind` question's state. */
export interface KindEvidence {
  readonly bookmark: CapturedEvidence;
  // What GitHub says about the repository the bookmark is in, for a GitHub bookmark: the GitHub
  // client's `GitHubEvidence` (github-client.ts, #123).
  readonly github?: object;
}

/** The chosen kind, and the probability of every kind. */
export interface KindAnswer {
  readonly kind: Kind;
  readonly probabilities: Readonly<Record<Kind, number>>;
}

const KindAnswerSchema = choiceAnswer(KINDS);

/** Asks what kind of resource the bookmark is. */
export async function askKind(
  config: JevConfig,
  evidence: KindEvidence,
  timing: JevTiming = JEV_TIMING,
): Promise<JevResult<KindAnswer>> {
  const result = await askJev(
    config,
    { state: evidence, id: "kind", question: KIND_QUESTION, answer: KindAnswerSchema },
    timing,
  );
  return result.ok
    ? {
        ...result,
        answer: { kind: result.answer.choice, probabilities: result.answer.probabilities },
      }
    : result;
}
