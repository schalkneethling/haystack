// Which bookmarks are GitHub repositories, or pages within one (#123). See "GitHub enrichment" in
// plans/haystack-v1-implementation-plan.md. This is a pure function: it reads only the URL, and
// the GitHub client (github-client.ts) asks GitHub about the repository it names.

/**
 * First path segments that are GitHub's own routes, not accounts, so `github.com/<segment>/…` is
 * never a repository. Compared in lower case, because github.com routes ignore case.
 *
 * Where the list comes from, checked on 2026-10-22:
 * - the first segments of every page in GitHub's marketing sitemap
 *   (https://github.com/sitemap_marketing.xml), except `github`, which is GitHub's organization;
 * - the first segments that GitHub's robots.txt (https://github.com/robots.txt) disallows, except
 *   the accounts it names and `account-login` (below);
 * - the routes the issue names, and other routes of the github.com app.
 *
 * Each one was checked against the REST API's `GET /users/{username}`, which answered 404, so no
 * account has the name and reserving it can't hide a repository. Two are exceptions, because an
 * account has the name but github.com serves GitHub's own pages under it: the sitemap shows
 * GitHub's stories at `github.com/customer-stories/<customer>`, and `github.com/biztools`
 * redirects to `/biztools/coupons`, which asks for sign-in, while that account has no public
 * repository. robots.txt also disallows `/account-login`, but that one is left out:
 * `github.com/account-login/bashrc` is a public repository of the account of that name. So are
 * other names that GitHub serves a page at but that are also accounts, such as `watching` and
 * `achievements`, because a repository could be under them. A route that is missing here costs
 * only the 2 GitHub requests, which answer 404.
 */
export const RESERVED_GITHUB_ROUTES: ReadonlySet<string> = new Set([
  "about",
  "account",
  "advisories",
  "apps",
  "biztools",
  "businesses",
  "codespaces",
  "collections",
  "contact",
  "copilot",
  "customer-stories",
  "dashboard",
  "discussions",
  "education",
  "enterprise",
  "enterprises",
  "events",
  "explore",
  "features",
  "gist",
  "home",
  "issues",
  "join",
  "login",
  "logos",
  "logout",
  "marketplace",
  "mobile",
  "models",
  "new",
  "nonprofit",
  "notifications",
  "open-source",
  "organizations",
  "orgs",
  "partners",
  "password_reset",
  "premium-support",
  "pricing",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "sessions",
  "settings",
  "signup",
  "site",
  "solutions",
  "spark",
  "sponsors",
  "stafftools",
  "stars",
  "team",
  "topics",
  "trending",
  "trust-center",
  "users",
  "why-github",
  "writing",
]);

// The characters Haystack accepts in an account and a repository name. GitHub's REST reference
// doesn't document its naming rules, so these are deliberately looser than the sign-up form
// (underscores appear in Enterprise Managed Users' names). They exist so the client builds its
// request path from nothing that needs encoding, and so a URL that can't name a repository isn't
// sent to GitHub at all.
const OWNER = /^[A-Za-z0-9_-]{1,39}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A GitHub repository that a bookmark is, or is in.
 * - `repository`: the bookmark is the repository's own page.
 * - `page`: the bookmark is a page within the repository, such as an issue, a pull request or a
 *   file. The repository is only context for that page, and must not be described as the page.
 */
export interface GitHubRepositoryMatch {
  readonly owner: string;
  readonly repo: string;
  readonly bookmark: "repository" | "page";
}

/**
 * The repository a bookmark's URL names, or undefined when it isn't a page on github.com within
 * a repository. Only the first two path segments identify the repository. The query and the
 * fragment don't change what the page is, so `?tab=readme-ov-file` and `#readme` are still the
 * repository's own page.
 */
export function matchGitHubRepository(url: string): GitHubRepositoryMatch | undefined {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return undefined;
  }
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  // `/owner/repo/` has an empty last segment, which is still the repository's own page.
  const segments = parsed.pathname.split("/").slice(1);
  if (segments.at(-1) === "") {
    segments.pop();
  }
  const [owner, name, ...rest] = segments;
  if (owner === undefined || name === undefined) {
    return undefined;
  }
  if (RESERVED_GITHUB_ROUTES.has(owner.toLowerCase()) || !OWNER.test(owner)) {
    return undefined;
  }
  // `github.com/owner/repo.git` is the clone address, which GitHub shows as the repository.
  const repo = name.endsWith(".git") ? name.slice(0, -".git".length) : name;
  if (!REPOSITORY.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  return { owner, repo, bookmark: rest.length === 0 ? "repository" : "page" };
}
