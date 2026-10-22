// Which URLs are GitHub repositories, or pages within one (#123). See "GitHub enrichment" in
// plans/haystack-v1-implementation-plan.md.
import { describe, expect, it } from "vite-plus/test";
import {
  type GitHubRepositoryMatch,
  matchGitHubRepository,
  RESERVED_GITHUB_ROUTES,
} from "../src/enrichment/github-url.ts";

const repository: GitHubRepositoryMatch = {
  owner: "vitest-dev",
  repo: "vitest",
  bookmark: "repository",
};
const page: GitHubRepositoryMatch = { ...repository, bookmark: "page" };

describe("matchGitHubRepository", () => {
  const matches: [string, string, GitHubRepositoryMatch][] = [
    ["a repository root", "https://github.com/vitest-dev/vitest", repository],
    [
      "a repository root with a trailing slash",
      "https://github.com/vitest-dev/vitest/",
      repository,
    ],
    [
      "a repository root with a query and a fragment",
      "https://github.com/vitest-dev/vitest?tab=readme-ov-file#readme",
      repository,
    ],
    ["the clone address", "https://github.com/vitest-dev/vitest.git", repository],
    ["an issue", "https://github.com/vitest-dev/vitest/issues/1234", page],
    ["a pull request", "https://github.com/vitest-dev/vitest/pull/42/files", page],
    ["a file", "https://github.com/vitest-dev/vitest/blob/main/README.md", page],
    ["a directory", "https://github.com/vitest-dev/vitest/tree/main/packages", page],
    [
      "a name with dots, underscores and capitals",
      "https://github.com/Some_Org/my.repo_Name",
      { owner: "Some_Org", repo: "my.repo_Name", bookmark: "repository" },
    ],
  ];
  it.each(matches)("matches %s", (_, url, expected) => {
    expect(matchGitHubRepository(url)).toEqual(expected);
  });

  const nonMatches: [string, string][] = [
    ["an owner-only URL", "https://github.com/vitest-dev"],
    ["an owner-only URL with a trailing slash", "https://github.com/vitest-dev/"],
    ["GitHub's home page", "https://github.com/"],
    ["a gist", "https://gist.github.com/octocat/6cad326836d38bd3a7ae"],
    ["another host", "https://gitlab.com/vitest-dev/vitest"],
    ["a host that ends in github.com", "https://notgithub.com/vitest-dev/vitest"],
    ["a subdomain of github.com", "https://docs.github.com/en/rest"],
    ["an http URL", "http://github.com/vitest-dev/vitest"],
    ["a port", "https://github.com:8443/vitest-dev/vitest"],
    ["credentials", "https://user:secret@github.com/vitest-dev/vitest"],
    ["an encoded segment", "https://github.com/vitest-dev/vi%2Ftest"],
    ["a repository named ..", "https://github.com/vitest-dev/%2E%2E"],
    ["an empty owner", "https://github.com//vitest"],
    ["text that isn't a URL", "github.com/vitest-dev/vitest"],
  ];
  it.each(nonMatches)("does not match %s", (_, url) => {
    expect(matchGitHubRepository(url)).toBeUndefined();
  });

  // Every reserved route, whatever follows it and however it is capitalized.
  it.each([...RESERVED_GITHUB_ROUTES])("does not match the reserved route %s", (route) => {
    expect(matchGitHubRepository(`https://github.com/${route}/anything`)).toBeUndefined();
    expect(matchGitHubRepository(`https://github.com/${route}/anything/deeper`)).toBeUndefined();
    expect(
      matchGitHubRepository(`https://github.com/${route.toUpperCase()}/anything`),
    ).toBeUndefined();
  });

  // The test's own list, so that removing a route from the code fails here. The first six are the
  // ones the issue and the plan name.
  const mustBeReserved = [
    "features",
    "orgs",
    "settings",
    "marketplace",
    "topics",
    "sponsors",
    "about",
    "apps",
    "biztools",
    "codespaces",
    "copilot",
    "customer-stories",
    "enterprise",
    "explore",
    "issues",
    "join",
    "login",
    "logout",
    "new",
    "notifications",
    "pricing",
    "pulls",
    "security",
    "site",
  ];
  it.each(mustBeReserved)("reserves %s", (route) => {
    expect(RESERVED_GITHUB_ROUTES.has(route)).toBe(true);
    expect(matchGitHubRepository(`https://github.com/${route}/anything`)).toBeUndefined();
  });

  // robots.txt disallows `/account-login`, but an account of that name has public repositories.
  it("does not reserve account-login, which has repositories", () => {
    expect(RESERVED_GITHUB_ROUTES.has("account-login")).toBe(false);
    expect(matchGitHubRepository("https://github.com/account-login/bashrc")).toEqual({
      owner: "account-login",
      repo: "bashrc",
      bookmark: "repository",
    });
  });

  it("does not reserve GitHub's own organization, which has repositories", () => {
    expect(matchGitHubRepository("https://github.com/github/docs")).toEqual({
      owner: "github",
      repo: "docs",
      bookmark: "repository",
    });
  });
});
