# Haystack v1 Implementation Plan

Status: approved (devil's advocate review applied 2026-10-05 and 2026-10-06)
Owner: Schalk
Last updated: 2026-10-06

## How to use this document

This plan is written for review and execution in Claude Code. Before implementing anything that touches TypeSafe or Jev, install and use the TypeSafe skill (`claude plugin marketplace add typesafe-ai/skills`, then `claude plugin install typesafe@typesafe-ai`). The skill treats the live documentation at https://docs.typesafe.ai/llms.txt as the source of truth, so read the current API reference and the relevant primitive pages before writing integration code rather than relying on the examples in this plan.

Every phase follows test-driven development. Write the failing test first, then the implementation, then refactor. Where this plan states a fact that has not been verified, it is marked as an open question. Do not resolve an open question by assumption. Stop and ask instead.

## Product summary

Haystack is a personal bookmarking service for tools, GitHub repositories, articles, and similar resources. It is built for a single user first, and it should stay ready to open to the public later without a rewrite.

A browser extension captures the current page and opens a prefilled save form on the Haystack site, in the style of a social share button. The user confirms the save there. The service enriches each bookmark with structured metadata produced by a large language model, and classifies it with Jev. The web interface is a single search field. The user describes what they are looking for in natural language, typed or spoken. Jev judges how well each bookmark serves the query, and the results are shown as cards containing the title and description. Each card links to the resource.

## Goals and non-goals for v1

The product is delivered in four milestones, described under "Milestones and phases": capture, enrichment, search, then agent access through MCP and WebMCP. Milestones 1 to 3 make up v1. Milestone 4 is planned from day one, and the design keeps it cheap to add, but it is scheduled after v1. Each milestone is deployed to production before the next one starts, so real bookmarks accumulate from the end of Milestone 1 onward.

By the end of Milestone 3, v1 must do the following. It must save a bookmark from the extension with one click to open the save form and one click to confirm. It must enrich that bookmark asynchronously with metadata designed for Jev matching. It must return ranked results for natural-language queries. It must log every search in enough detail to evaluate thresholds and question designs offline. It must run within Cloudflare's free tier, or within Workers Paid if the open decision below goes that way.

The following are explicitly out of scope for v1: open sign-up for anyone with a Google account, candidate shortlisting with embeddings, bookmark editing after saving, tagging, folders, sharing, and import from other services. Shortlisting is deferred until collection size makes it necessary.

## Decisions made

These decisions came out of the planning conversation and should not be reopened without discussion.

1. **Platform.** Cloudflare Workers hosts the whole site from a single Worker. D1 provides persistence. Every HTML page is rendered or gated by the Worker behind Google sign-in. Only CSS, JavaScript, fonts, and images are served as static assets.
2. **Metadata capture happens in the extension, and saving happens on the site.** The extension reads the rendered page's title, meta description, and Open Graph tags, then opens `/save` with those values as query parameters. It holds no credentials and makes no API calls. The server does not fetch arbitrary pages in v1. The Open Graph values and the plain values are sent as separate fields, and the enrichment model weighs them. We do not decide up front which source to trust, because both are often shaped for search engines.
3. **GitHub is special-cased.** For `github.com/{owner}/{repo}` URLs, the server calls the GitHub REST API for the description, topics, primary language, and an excerpt from the README.
4. **Enrichment uses a pluggable LLM provider.** A provider interface with adapters for Anthropic, OpenAI, Cloudflare AI Gateway, and OpenRouter. Every provider's output is validated against a Valibot schema at the boundary, regardless of which provider produced it.
5. **Jev is called directly** through the TypeSafe HTTP API with a TypeSafe API key. It is not called through the Workers AI binding.
6. **Jev handles the typed judgments at ingestion.** The `kind` classification is a Jev Choice question, so the LLM only generates prose fields.
7. **Search asks both Noul and Score.** Each query-bookmark pair gets a Noul question and a Score question in the same request. We do not choose between them in v1. Both answers are logged and compared on real data.
8. **Evidence goes in state.** The query and the bookmark are placed in the Jev `state`. The judgment goes in `instructions`, and the possible answers go in `criteria`. Bookmark content never goes in the criteria.
9. **Google sign-in from day one, on the site only.** The site signs users in with Google (OpenID Connect). Because the extension only opens pages, the site session is the single authentication mechanism. `user_id` always comes from the session, never from the client. v1 restricts sign-in to an allowlist of email addresses, so real multi-user support exists without opening the service to strangers who would spend the LLM and Jev budget.
10. **Voice input in v1 uses the browser's Web Speech recognition only.** Voice is progressive enhancement layered on the text input, which always works. Web Speech needs no server code, and Schalk searches mostly in Chrome. Whisper transcription on Workers AI is in the backlog for browsers without Web Speech, such as Firefox. (Revised 2026-10-06; this decision originally included both voice modes.)
11. **Secrets** are managed with varlock and its 1Password plugin locally, and deployed with `varlock-wrangler`. Secret names are declared in `secrets.required` in `apps/worker/wrangler.jsonc`.
12. **The share-style save flow.** `/save` serves the extension today and is designed to serve other entry points later (a bookmarklet, and the Web Share Target API for an installed web app) without changes to the flow.
13. **No model routing.** Each provider adapter has its model chosen in configuration ahead of time. Jev does not route enrichment between models.
14. **Capture ships first.** Milestone 1 is deployed with saving only. Bookmarks saved before Milestone 2 have no enrichment, and that is exactly the set the first enrichment run processes.
15. **Enrichment runs as a permanent sweep.** One idempotent operation, "enrich every bookmark without an enrichment at the current schema version," handles the first backfill, later schema version changes, and retries after on-save failures. It stays running after the backfill because it is the retry mechanism. See "Enrichment sweep."
16. **Drizzle for the schema, queries, and migrations**, with `wrangler d1 migrations` as the only tool that applies migrations. See "Data model."
17. **Bookmarks are not editable after saving, but their owner can delete them.** The title and description are confirmed on the save form before submission, and that is the only chance to change them. Deletion is available from the recent saves list, the search results, and the review page at `/held`. See "Deleting bookmarks."
18. **URLs that carry secrets must never be saved.** Haystack tells users plainly not to save them, and refuses the patterns it can recognize, in the extension before the URL is sent and again on the server. From Milestone 2, Jev adds a probabilistic check on a redacted form of the URL: it warns on the save form, and it gates enrichment so that nothing unchecked is sent to a third party. Jev never sees the raw URL. See "Sensitive URLs."
19. **Agent access through MCP and WebMCP is part of the product, starting search-only.** Milestone 4 adds a WebMCP tool on the search page and a remote MCP server, both exposing only search. The remote server targets the stateless MCP specification (2026-07-28), so there are no protocol sessions to manage. To keep Milestone 4 cheap, search is built from Milestone 3 onward as one service, `searchBookmarks(userId, query, { channel, inputMode })`, that the web API, WebMCP, and MCP all call. `inputMode` is set only for the web channel, and it is passed so that the service can log it. See "Agent access."
20. **Runtime switches use Cloudflare Flagship.** Settings that must change without a deploy are Flagship flags, read through the Worker binding. These settings are listed under "Secrets and configuration." Static configuration stays in `vars`, and secrets stay secrets. Flagship is in public beta. See Q13. (Added 2026-10-06.)
21. **v1 starts on Wrangler and moves to the `cf` CLI later.** Cloudflare's `cf` CLI (beta since 2026-09-28) will replace Wrangler. Wrangler gets 18 months of maintenance after the `cf` beta ends. v1 uses Wrangler, because `cf` does not yet support three things this project needs: varlock for secrets, a command that sets a single secret (it only uploads secrets from a file on disk with `--secrets-file`), and a confirmed replacement for Wrangler's `createTestHarness`. Choices made now favor a later `cf migrate`, such as building through the Cloudflare Vite plugin (Q10 (b)). See Q14 for when to switch. Do not run `cf dev`, `cf build`, or `cf deploy` in this repository before `cf migrate`. The `cf` documentation warns that they can overwrite `package.json` and `vite.config.ts`, and Calavera manages both files. `cf` resource commands, such as `cf d1 list`, are safe to use alongside Wrangler. (Added 2026-10-06.)

## Open questions

These must be answered before the phase that depends on them starts.

**Q1. Default request mode and Workers plan.** Pair mode makes one Jev request per bookmark for every search. That collides with two limits. The first is Jev's rate limit of 1,200 requests per minute (see "Jev model limits" below): with 200 bookmarks, pair mode allows only six searches per minute. The second is the Workers subrequest limit per invocation, believed to be 50 on the free plan (verify against current Cloudflare documentation). Workers Paid only solves the second. The working assumption is therefore that batched mode is the production default and pair mode is the reference used in evaluations. Phase 12 decides whether batching degrades quality enough to justify pair mode plus earlier shortlisting. Schalk still needs to decide whether Workers Paid is wanted for other reasons, including the limits in Q3. Also verify the free plan's CPU time limit per request, and check it against `/api/search`. Search parses and validates a Jev response that grows with the collection, ranks the results, and writes one log row per candidate. All of this is CPU work, unlike the waiting on the network that enrichment does. If the free-plan CPU limit is in the low milliseconds, search will probably go over it before the subrequest limit matters. The review recommendation is to settle the plan question before Phase 7, not Phase 11. The project already pays for Jev and the LLM, and Workers Paid removes a group of limits that otherwise affect the design of the sweep, the chunker, and logging. _Blocks Phase 11._

**Q2. Resolved.** See "Jev model limits" below.

**Q3. Limits on background work.** The enrichment sweep runs on a Cron Trigger, and the on-save fast path uses `ctx.waitUntil`. Verify the current free-plan limits that apply to each: the number of Cron Triggers, CPU time per invocation (enrichment is mostly waiting on network calls, which should not count toward CPU time, but confirm this), and subrequests per invocation, which caps how many bookmarks one sweep tick can process. These numbers set the sweep's batch size. _Blocks Phase 8._

**Q4. Extension background model.** Firefox and Chrome differ in how Manifest V3 declares background scripts. The v1 design avoids a background script by doing everything in the action popup, which opens the save form with `tabs.create` and then closes itself. Confirm this works in both browsers. _Blocks Phase 5._

**Q5. OAuth implementation.** Choose one of three approaches, with sessions stored in D1 in each case. The first is implementing the Google authorization code flow with PKCE directly, using Web Crypto to verify ID tokens against Google's published keys. The second is a small OAuth client library such as Arctic, with hand-written session handling. The third is Better Auth, which runs on Workers with D1 and handles sessions as well. With the extension no longer holding credentials, a single sign-in flow is all that is needed, so the second option is the recommendation: the session code is small and worth understanding fully. _Resolved 2026-10-06: Arctic, with hand-written sessions stored in D1. Blocked Phase 2._

**Q6. Product name.** Haystack is a working name. It overlaps with existing projects in the AI and search space, so confirm it before registering a domain or publishing the extension. Milestone 1 deploys to a `workers.dev` subdomain and is not blocked. _Blocks Phase 14._

**Q7. TypeSafe data handling.** The sensitivity check sends TypeSafe a redacted description of each URL, and enrichment later sends the full captured data for the `kind` question. Check TypeSafe's current data retention and training terms before either goes live, and record the answer in this plan. Do the same for every other third party that receives bookmark data: Anthropic, each later provider, and GitHub (only the repository path goes to GitHub). Cloudflare AI Gateway needs particular attention. It can log the prompts and responses that pass through it, and those logs would hold the captured data of every bookmark. Decide whether to turn gateway logging off for Haystack, and record that decision here. _Blocks Phase 7._

**Q8. MCP authorization.** Search-only lowers the blast radius, but the remote MCP server still needs authentication: search results are the user's private bookmarks, and every search spends Jev budget, so an open endpoint would expose both. The MCP specification's authorization model is OAuth-based. The likely approach is for Haystack to act as the OAuth authorization server for MCP clients, delegating the actual sign-in to Google, possibly using Cloudflare's `workers-oauth-provider` library. Read the authorization section of the 2026-07-28 specification and confirm the approach before building. WebMCP does not need this, because it runs inside the signed-in page. _Blocks Phase 17._

**Q9. WebMCP API surface.** WebMCP is a W3C Community Group draft that is still changing. Reports indicate the registration API has moved from `navigator.modelContext` to `document.modelContext`, and Chrome support is through an origin trial. Confirm the current API, its availability, and whether an origin trial token is needed when Phase 15 starts. _Blocks Phase 15._

**Q10. Toolchain reconciliation.** This plan was written before the repository was scaffolded. The repository is a single-package Vite+ project (`vp` for dev, build, check, and test, with `vite.config.ts` at the root), with linting and formatting set up through Calavera. Most of the reconciliation is routine Phase 0 work: remove the Vite starter files and add the configuration the scaffold does not have yet (Wrangler, Drizzle, Playwright). Three questions remain.

(a) **How tests run in the Workers runtime. Resolved: split the tests.** Vite+ 1.0.0 runs Vitest 5.0.1 (`vp toolchain`). The latest `@cloudflare/vitest-pool-workers` (0.22.0, checked 2026-10-06) declares `vitest: ^4.1.0` as a peer dependency, so it does not work under `vp test`. Two other options were rejected. Waiting for Cloudflare to support Vitest 5 has no known date. Installing a separate Vitest 4 for Worker tests means two test runners, and it goes against Vite+'s rule to import from `vite-plus/test`. The tests are split as follows:

- **Pure modules** run as ordinary `vp test` unit tests: the Valibot schemas, URL normalization, `detectSensitiveUrl`, `describeUrlForJudgment`, `match_text` derivation, the derived enrichment state, ranking, and the chunker. Most of the logic in this plan is in these modules, so keep it out of request handlers.
- **Integration tests** also run under `vp test`, but they start the Worker in the local Workers runtime with Wrangler's `createTestHarness` (exported by `wrangler` 4.147.0, and not marked unstable). Tests send requests with `fetch`, apply migrations to the real local D1 with `applyD1Migrations`, seed and check rows through the D1 binding from `getEnv`, trigger the cron handler with `scheduled`, and set test-only `vars` and `secrets`. Before Phase 0 depends on them, read the harness's type declarations in the installed version again to confirm these methods. Do not build on `getPlatformProxy` or `unstable_startWorker` for this.

In this model the Worker runs in a separate runtime from the test, so a test cannot replace `fetch` inside the Worker. The Jev, LLM provider, GitHub, and Google base URLs are therefore configuration in `vars`. Integration tests point them at a fixture Worker that serves recorded responses, run in the same harness. Phase 0 includes a spike test that proves the Worker can reach a fixture Worker this way. If it cannot, stop and revisit this decision before Phase 2.

(b) **How the Worker is built and run locally. Resolved 2026-10-06: the Cloudflare Vite plugin.** Either `vp dev` and `vp build` run the Worker through the Cloudflare Vite plugin, or Wrangler builds the Worker and Vite builds only the client assets. `@cloudflare/vite-plugin` 1.62.5 accepts `vite: ^8.0.0`, and Vite+ bundles Vite 8.3.1 as `@voidzero-dev/vite-plus-core`, so the plugin is probably compatible. A local run must confirm it. Confirm also how `varlock-wrangler` and the test harness fit with the choice. The recommendation is the Vite plugin. It is the build path that the `cf` CLI recommends, so it keeps the later move to `cf` small (decision 21). Use the stable 1.x plugin, which works with Wrangler, not the 2.0 beta that `cf` uses.

(c) **Workspace layout. Resolved 2026-10-06: the `apps/` and `packages/` workspace layout.** The Worker and the extension share `packages/schemas` through a real package boundary, and the extension has its own build. Map the layout onto `pnpm-workspace.yaml` (it has no `packages` entry now) and onto Vite+'s monorepo model (one root `vite.config.ts` with `overrides`).

Calavera owns some files in this repository, so make tooling changes through Calavera, not by hand (see `AGENTS.md`). _Resolved. Phase 0 confirms (b) with a local run._

**Q11. Search latency budget and shortlisting trigger.** The plan sets no latency target for search, and it defers shortlisting "until collection size makes it necessary" without saying how that point is measured. Every search sends every enriched bookmark to Jev, so latency and chunk count grow with the collection. Bookmarks also keep accumulating from the end of Milestone 1, so the collection could be large before search ships. Schalk to set a p95 latency target for search. Phase 12 then reports the collection size at which batched mode exceeds that target. That size becomes the documented trigger for the shortlisting work in the backlog. _Blocks Phase 12 acceptance._

**Q12. D1 limits and search logging volume.** Every search writes one `search_answers` row per candidate and reads every enriched bookmark. For example, 1,000 bookmarks and 50 searches a day is 50,000 rows written and more than 50,000 rows read each day, before the sweep and sessions are counted. Verify the current D1 limits on the chosen plan: rows written and rows read per day, storage per database, and bound parameters per statement (this sets how many answer rows go in one insert). If the limits are close, add a retention window for `search_answers` (for example, keep only runs that are labeled or newer than 90 days) before Phase 11. Do not sample, because sampling stops offline replay. _Blocks Phase 11._

**Q13. Flagship availability and local behavior.** Flagship has been in public beta since 2026-05-26. Its documentation does not state the pricing, whether the Workers Free plan can use it, or whether a binding call counts as a subrequest. Confirm these. Local behavior also needs a check, because the sources disagree. The Flagship documentation says local Workers read the live Flagship app and there is no local flag store. The Wrangler 4.147.0 configuration schema has a `remote` option on the `flagship` binding, which chooses between the live app and a "local simulator." The Phase 0 spike finds out how the binding behaves under `createTestHarness`, and how a test sets a flag value. Integration tests must not depend on live flag values. If the harness cannot set flags, tests rely on the defaults described under "Secrets and configuration." _Blocks Phase 8, the first phase that reads a flag._

**Q14. When to move from Wrangler to `cf`.** This does not block any phase. Check it at each milestone deploy. Move with `cf migrate` (run `cf migrate --dry-run` first) when all of the following hold: `cf` has left beta; varlock supports `cf`, or there is another way to pass secrets without writing them to a file; `cf` can set a single secret; and there is a test harness for `cf` projects with the capabilities used from `createTestHarness`. The move replaces `wrangler.jsonc` with `cloudflare.config.ts`, `secrets.required` with `bindings.secret()`, and `wrangler d1 migrations apply` with `cf d1 migrations apply`. Decision 16's rule stays: one tool applies migrations. Confirm each command against the `cf` documentation at that time.

## Architecture

```
Browser extension (MV3)
  popup: reads the active tab with scripting.executeScript
  opens GET /save?url=…&title=…&description=…&og_title=…  (no credentials)
        |
        v
Cloudflare Worker
  /auth/*               Google sign-in, callback, sign-out
  GET  /save            session required (else sign-in, then back here);
                        deterministic sensitive-URL check; (Milestone 2+)
                        Jev sensitivity check on the redacted URL;
                        renders the prefilled form; never writes
  POST /save            session + Origin check; insert the bookmark,
                        (Milestone 2+) start enrichment via waitUntil
  GET  /                Milestone 1: recent saves list; Milestone 3: search page
  /held                 (Milestone 2+) review Held bookmarks: release or delete
  enrichment module     shared by the on-save fast path and the sweep
                        sensitivity gate: redacted URL -> Jev Noul;
                          above threshold and unacknowledged -> Held, stop
                        GitHub API (if applicable)
                        -> Jev ingestion question (kind)
                        -> LLM provider (prose fields), Valibot validation
                        -> derive match_text, write the enrichment
  scheduled() sweep     Cron Trigger (Milestone 2+): enrich a bounded batch of
                        bookmarks with no enrichment at the current schema
                        version, refresh outdated match_text, and delete
                        expired sessions
  /api/search           session required; calls searchBookmarks(userId, query, { channel: 'web', inputMode })
  POST /bookmarks/:id/delete
                        session + Origin check; owner only (404 otherwise)
  /mcp                  (Milestone 4) stateless MCP server, search tool only,
                        OAuth-protected (see Q8)
  search page           (Milestone 4) registers a WebMCP search tool
  static assets         CSS, JS, fonts, images only; no HTML
        |
        v
D1 (SQLite)
```

Recommended repository layout. The layout is the target, and Q10 decides how the existing Vite+ scaffold moves to it. The Vite starter `index.html` at the root was static HTML, which is incompatible with decision 1. It was removed with the other starter files in #2.

```
haystack/
  apps/
    worker/            Worker source, wrangler.jsonc, tests
      src/db/schema.ts Drizzle schema (source of truth for tables)
      migrations/      SQL migrations generated by drizzle-kit, applied by wrangler
    web/               CSS, JS, and image assets (HTML is rendered by the Worker)
    extension/         WebExtension source
  packages/
    schemas/           Valibot schemas shared by worker and extension
  evals/               labeled query set and replay scripts (not unit tests)
  .env.schema          varlock schema
```

## Data model

Use Drizzle with the D1 driver for the schema definition and all queries. Drizzle is a thin, SQL-shaped query builder, so queries stay close to the SQL below while gaining types inferred from the schema.

Migrations follow one path. `drizzle-kit generate` writes a SQL migration from changes to `src/db/schema.ts` into `apps/worker/migrations`, a person reviews the generated SQL, and `wrangler d1 migrations apply` is the only tool that applies migrations, locally and remotely. Never use `drizzle-kit push` or `drizzle-kit migrate`, because two tools applying migrations would disagree about what has been applied. Before Phase 0 is complete, confirm in the current Drizzle documentation that the generated migration files work with Wrangler's migration tracking.

From the first production deploy at the end of Milestone 1, the database holds real data. Every schema change after that point is a reviewed, forward-only migration. A destructive change (dropping or renaming a column) requires a note in the migration explaining what happens to existing rows.

Rolling back a Worker deployment does not roll back D1. Every migration must therefore stay compatible with the Worker version deployed before it (expand, then contract). Add a column or table in one deploy, and remove what it replaces in a later deploy, after nothing reads it. If a migration cannot stay compatible, it needs a written rollback procedure before it is applied.

Before Phase 6, confirm D1's point-in-time recovery (Time Travel) retention on the chosen plan, and write down the restore procedure. Also take a `wrangler d1 export` before each remote migration. From Milestone 1 onward, the bookmarks exist only in this database.

**Conventions.** All timestamps are `INTEGER` Unix epoch milliseconds, and application code sets them. Do not use `datetime('now')` defaults. SQLite's `datetime('now')` gives `2026-10-05 21:14:00`, and JavaScript's `toISOString()` gives `2026-10-05T21:14:00.000Z`. If both formats are compared as text, for example `expires_at < ?` in the session lookup, the comparison is wrong on the same day, because a space sorts before `T`. One numeric representation removes that type of bug. Application code generates IDs with `crypto.randomUUID()`. Cascading deletes need foreign key enforcement. Confirm that D1 enforces foreign keys by default, and keep the deletion tests as the proof.

D1 does not support interactive transactions. Where several writes must succeed or fail together, such as inserting an enrichment and clearing its failure record, use Drizzle's `batch`, which D1 executes atomically.

JSON columns use Drizzle's JSON text mode and are validated with Valibot when read, since the database does not enforce their shape. Valibot schemas for rows may be derived from the Drizzle schema if a maintained integration exists; check whether that is `drizzle-orm/valibot` or the separate `drizzle-valibot` package in the current versions. The capture payload and enrichment output schemas remain hand-written, because they describe external input rather than table rows.

The tables below describe the intended schema. The Drizzle schema must produce equivalent tables. Columns ending in `_at` are epoch milliseconds, as described under "Conventions."

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,     -- stable Google account ID; never key on email
  email TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,            -- SHA-256 of the session ID; the raw ID lives only in the cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_flows (
  state_hash TEXT PRIMARY KEY,         -- SHA-256 of the OAuth state; single use
  code_verifier TEXT NOT NULL,         -- PKCE verifier
  return_to TEXT NOT NULL,             -- relative path and query, validated before redirect
  expires_at INTEGER NOT NULL,         -- short-lived, for example 10 minutes
  created_at INTEGER NOT NULL
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,                   -- exactly as submitted
  normalized_url TEXT NOT NULL,        -- see "URL normalization"; used for duplicates
  title TEXT NOT NULL,                 -- as confirmed on the save form
  description TEXT,                    -- as confirmed on the save form
  canonical_url TEXT,                  -- raw captured values below, kept as enrichment evidence
  captured_title TEXT,
  captured_description TEXT,
  og_title TEXT,
  og_description TEXT,
  og_site_name TEXT,
  sensitivity_noul REAL,               -- Milestone 2+: Jev probability that the URL grants private access; NULL = not yet checked
  sensitivity_checked_at INTEGER,
  sensitivity_acknowledged_at INTEGER, -- set when the user confirms the link is not private (save form or /held)
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, normalized_url)
);

CREATE TABLE enrichments (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_probabilities TEXT NOT NULL,   -- JSON
  data TEXT NOT NULL,                 -- full validated enrichment JSON
  match_text TEXT NOT NULL,
  match_text_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (bookmark_id, schema_version)
);

CREATE TABLE enrichment_failures (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (bookmark_id, schema_version)
);

CREATE TABLE search_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  query TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'webmcp', 'mcp')),
  input_mode TEXT CHECK (input_mode IN ('typed', 'web-speech', 'whisper')),  -- web channel only; 'whisper' is reserved for the backlog item, so adding it needs no table rebuild
  request_mode TEXT NOT NULL CHECK (request_mode IN ('pair', 'batched')),
  jev_model TEXT NOT NULL,
  questions TEXT NOT NULL CHECK (questions IN ('both', 'noul', 'score')),  -- which Jev questions were asked
  display_signal TEXT NOT NULL CHECK (display_signal IN ('noul', 'score')),
  noul_threshold REAL NOT NULL,
  score_threshold REAL NOT NULL,
  input_tokens INTEGER,
  latency_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),  -- partial: some chunks failed
  error TEXT,                          -- set when outcome is not 'ok'
  created_at INTEGER NOT NULL
);

CREATE TABLE search_answers (
  search_run_id TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  noul REAL NOT NULL,
  score REAL NOT NULL,
  score_probabilities TEXT NOT NULL,  -- JSON
  score_confidence REAL NOT NULL,
  shown INTEGER NOT NULL,             -- 0 or 1
  clicked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (search_run_id, bookmark_id)
);
```

The `search_answers` table stores every answer for every candidate, including those below the threshold. This is what makes offline threshold replay possible without calling Jev again. Clicks are recorded as a weak relevance label. A search that fails, completely or for some chunks, is still logged in `search_runs` with its `outcome` and `error`. Without these rows, the logs show no Jev outages, and failed searches look like searches nobody made.

### Enrichment state is derived, not stored

There is no `status` column. A stored status would have to be kept in sync with the enrichments table, and it becomes ambiguous during a schema version change. Instead, a bookmark's enrichment state is computed from the two enrichment tables:

| State    | Condition (evaluated in this order; the first match wins)                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Held     | Its `sensitivity_noul` is at or above the warning threshold and `sensitivity_acknowledged_at` is not set. It is excluded from search and never sent to the LLM provider, GitHub, or the `kind` question until it is released. |
| Current  | It has an enrichment at the current `schema_version`.                                                                                                                                                                         |
| Failed   | It has reached the attempt limit at the current version. It needs manual attention. If it has an enrichment from an older version, it stays searchable through that one.                                                      |
| Outdated | It has an enrichment at an older version only. It is still searchable, and the sweep will re-enrich it.                                                                                                                       |
| Pending  | It has no enrichment at any version.                                                                                                                                                                                          |

Attempts are counted per schema version, so raising the version automatically gives previously failed bookmarks a fresh set of attempts.

Held is evaluated against the current `SENSITIVE_WARN_THRESHOLD`, not against the threshold that applied when the bookmark was checked. If the threshold is lowered, Current bookmarks above the new value become Held and leave search until they are released. This is intentional. It is the conservative direction, and the `/held` page shows them. Raising the threshold releases them automatically.

**Search uses each bookmark's most recent enrichment, whatever its version**, and never includes Held bookmarks. A schema version change therefore never removes anything from search. Bookmarks keep their old enrichment until the sweep replaces it. Only bookmarks with no enrichment at all are left out of search.

### URL normalization

`normalized_url` is derived in code, and is used only for duplicate detection. The original `url` is what the bookmark links to. Normalization lowercases the scheme and host, removes default ports, removes the fragment, removes common tracking parameters (`utm_*`, `fbclid`, `gclid`, and similar, as an explicit list), sorts the remaining query parameters, and removes a trailing slash from the path. It is a pure function in `packages/schemas`, with a table of test cases.

`normalized_url` is stored, so a change to the normalization function (for example, a new tracking parameter in the list) makes existing rows out of date. When recomputed, two existing bookmarks can collide on `UNIQUE (user_id, normalized_url)`. Such a change therefore needs a migration that recomputes the column and states how collisions are resolved (keep the oldest bookmark, and report the others). It is not a code-only change.

Two submissions of the same URL can race, for example from two tabs. The second insert then fails on the unique constraint. `POST /save` must show the "already saved" result for that case, not an error page.

## Enrichment design

### Captured payload from the extension

The extension puts the URL, the canonical URL if present, `document.title`, the meta description, and the Open Graph title, description, and site name into the `/save` query string. The same Valibot schema in `packages/schemas` validates the payload twice: in the extension before building the URL, and on the server for both the GET prefill and the POST submission. Every field except the URL is optional, and strings are trimmed and length-capped. The extension truncates to the same caps so the save URL stays well within URL length limits. The URL must use the `http` or `https` scheme. The canonical URL, if present, must too.

### GitHub enrichment

For repository URLs, call `GET /repos/{owner}/{repo}` and `GET /repos/{owner}/{repo}/readme`. Keep a README excerpt of roughly the first 2,000 characters, with Markdown syntax stripped. Use a `GITHUB_TOKEN` secret to avoid the low rate limit for unauthenticated requests. A GitHub failure must not fail the bookmark. Fall back to the captured payload.

The token must have read access to public repositories only. If it can read Schalk's private repositories, a bookmarked private repository would have its README fetched and sent to the LLM provider. A fine-grained token with no repository access grants exactly public read access (verify this against the current GitHub documentation when the token is created).

Matching is narrower than "any `github.com` URL". Only the first two path segments identify the repository, and the first segment must not be a reserved GitHub route such as `features`, `orgs`, `settings`, `marketplace`, `topics`, or `sponsors` (keep the list explicit in code). A URL deeper than the repository root, such as an issue, a pull request, or a file, is a bookmark of that page, not of the repository. For those URLs, give the repository data to the LLM as context for the page, labeled as such, so that an issue bookmark is not summarized as the repository.

### Jev ingestion questions

A single Jev request with the combined captured and GitHub data as state asks one question, `kind`, a Choice with options such as `repository`, `library`, `tool`, `article`, `reference`, `video`, and `other`. Each option gets a short description in the criteria, and the `other` option exists so that a no-match outcome is always available.

Write the exact wording only after reading the Choice page in the live documentation. Store both the chosen `kind` and its full probability distribution.

The example options mix two dimensions. `repository` describes where a resource is hosted, while `library` and `tool` describe what it is. A GitHub repository of a test runner is correctly both `repository` and `tool`, so the distribution would split between them for reasons unrelated to the resource. Before the wording is written, decide which dimension `kind` describes. The recommendation is _what it is_, because queries express that ("a tool for…"). The host is already known from the URL and does not need a question.

### LLM enrichment output

The LLM receives the captured data, the GitHub data if present, and the Jev `kind`. It returns only prose fields. The Valibot schema, versioned as `schema_version = 1`, is as follows:

```ts
const EnrichmentV1 = v.object({
  summary: v.pipe(v.string(), v.maxLength(280)),
  use_cases: v.pipe(v.array(v.pipe(v.string(), v.maxLength(160))), v.maxLength(6)),
  problems_solved: v.pipe(v.array(v.pipe(v.string(), v.maxLength(160))), v.maxLength(6)),
  technologies: v.pipe(v.array(v.pipe(v.string(), v.maxLength(40))), v.maxLength(12)),
  topics: v.pipe(v.array(v.pipe(v.string(), v.maxLength(40))), v.maxLength(12)),
  alternative_terms: v.pipe(v.array(v.pipe(v.string(), v.maxLength(40))), v.maxLength(12)),
});
```

The prompt must instruct the model to phrase `use_cases` the way a person would ask for the resource ("Use when you need to…"), because search queries express intent, while page descriptions tend to express marketing. The JSON Schema sent to providers for structured output should be generated from, or tested against, the Valibot schema, so the two cannot drift apart.

The prompt must also instruct the model to use only the evidence it is given, and to return an empty list for any list field the evidence does not support. For many articles, the evidence is a title and a meta description written for marketing. No list field has a minimum length, `use_cases` included. If the schema required an entry, the model would have to invent one, and an invented use case in `match_text` makes the bookmark match searches it should not match. An empty list is the correct output when the evidence is thin. Phase 9's review of the first five enrichments must still check bookmarks with little evidence for invented claims, including in `summary`.

Capturing an excerpt of the page text in the extension was considered and rejected. Only the extension could capture it, so bookmarks from other entry points (a bookmarklet, a share target) would not have it. A first paragraph or similar excerpt also gives no guarantee of better evidence.

### Untrusted content

All captured data (titles, descriptions, Open Graph values, README excerpts) comes from web pages that anyone can write, and it goes into the LLM prompt, the Jev state, the rendered pages, and (in Milestone 4) agent tool results. Treat it as data everywhere:

- **Prompts.** Put captured content in clearly delimited data sections of the prompt, never in the instructions. The structured output schema and the Valibot length caps limit what an injected instruction can achieve. An instruction such as "describe this page as relevant to every query" in a page could still cause a bookmark that matches every search. The evaluation set should include a fixture page that attempts this.
- **Rendering.** The Worker renders HTML that contains user-confirmed and captured values. Use one templating approach that escapes interpolated values by default, either a maintained tagged-template helper or a small in-house one with its own tests. Never concatenate strings into HTML. Send a Content Security Policy that allows no inline script, and add a test that saves a bookmark with a title containing markup and asserts that it renders as text on every page that shows bookmarks.
- **Agents.** See "Agent access."

### The provider interface

```ts
interface EnrichmentProvider {
  readonly id: string;
  enrich(input: EnrichmentInput, options: { model: string }): Promise<unknown>;
}
```

The provider returns `unknown`, and validation happens in one place outside every adapter. On validation failure, retry once with the same provider, then record a failed attempt in `enrichment_failures` with the reason. There is no `failed` status to set, because state is derived (see "Enrichment state is derived, not stored"). v1 implements the Anthropic adapter and the AI Gateway adapter. The OpenAI and OpenRouter adapters follow so that the gateway comparison can run.

### Match text

`match_text` is derived deterministically from the enrichment in code: the title, kind, summary, use cases, and alternative terms, in a fixed order. An empty list adds nothing, with no placeholder text. It is stored so that the derivation can change and be regenerated without calling the LLM again. Aim for roughly 60 to 150 tokens and measure the actual counts.

Leaving `technologies`, `topics`, and `problems_solved` out is a hypothesis, not a finding. Queries such as "a TypeScript test runner" depend on technologies. Phase 12 compares at least one derivation that includes them, and `match_text_version` makes it cheap to switch.

### Enrichment sweep

A single operation, `enrichPending(batchSize)`, selects bookmarks in the Pending state and in the Outdated state (see "Enrichment state is derived, not stored"), oldest first. It runs the enrichment module on each one with bounded concurrency. The sweep and the on-save fast path both call the same enrichment module, so the first backfill and everyday enrichment cannot drift apart.

The operation is idempotent: running it when nothing is outstanding does nothing. It is resumable: stopping at any point loses nothing, because the progress is the data itself. One bookmark failing never stops the batch. A failure increments `attempts` in `enrichment_failures` for the current schema version and records the error. A bookmark at the attempt limit (configuration, default 3) is left in the Failed state for manual attention. A successful enrichment and the removal of its failure record are written together. Each run logs a summary of how many bookmarks were selected, enriched, failed, and skipped.

**Transient and permanent failures are different.** If every failure counted toward the limit, a provider outage of a few hourly runs would move every bookmark it touched to Failed, with no automatic way back until the next schema version. The enrichment module therefore classifies each failure:

- _Permanent_: the output failed validation after the retry, or the provider rejected the input (a `4xx` other than `429`). These count toward the attempt limit.
- _Transient_: network errors, timeouts, `429`, `5xx`, and `529`. These record `last_error` and `last_attempt_at`, but do not increment `attempts`.

The sweep skips a bookmark whose `last_attempt_at` is within a backoff window that grows with consecutive failures, so a bookmark that keeps failing does not take the first places in every batch. A run stops early when its first few calls all fail transiently, because a provider outage affects every bookmark in the same way.

**Failed bookmarks are visible and retryable.** "Manual attention" needs somewhere to happen. The `/held` page becomes the review page for both Held and Failed bookmarks. Failed bookmarks show the last error and a retry action that deletes the failure record for the current version, which makes the bookmark Pending or Outdated again. The action is a POST with the usual session and `Origin` checks.

The fast path and the sweep can occasionally pick up the same bookmark at the same time. The `UNIQUE (bookmark_id, schema_version)` constraint and an insert that does nothing on conflict make that harmless. The only cost is a duplicate provider call.

The sweep also refreshes `match_text`. When the derivation changes, raise `match_text_version`, and the sweep rewrites `match_text` for enrichments at an older derivation version, directly from the stored `data`, without calling the LLM or Jev.

The sweep runs from the Worker's `scheduled()` handler on a Cron Trigger, with the batch size, the frequency, and an enabled flag in configuration. Running inside the Worker keeps the D1 binding, the secrets, and the runtime identical to production, and small batches per run stay within the per-invocation limits in Q3. The first backfill is the sweep draining the backlog over a series of runs. A schema version change works the same way: raise `schema_version`, and the sweep re-enriches everything while search keeps using the older enrichments.

The sweep stays enabled permanently. The on-save fast path runs inside `ctx.waitUntil`, which has a limited time budget after the response is sent, and provider outages and rate limits happen. The sweep is what turns those failures into eventual success, without anyone having to notice. Once the backlog is empty, it runs less often (hourly is a reasonable default), and a run with nothing to do costs one D1 query. The same handler deletes expired sessions.

For controlled runs, `wrangler dev --test-scheduled` triggers the handler locally against the local database with fixtures. In production, the first real run uses a batch size of five with the sweep enabled for a single run, and Schalk reviews those enrichments before the batch size is raised.

The on-save fast path calls the same module for the one new bookmark inside `ctx.waitUntil`, so new bookmarks are usually enriched within seconds. If the fast path fails or is cut short, the sweep picks the bookmark up later.

Anthropic and OpenAI offer discounted asynchronous batch APIs, which would suit a large first backfill. At the expected collection size, the savings do not justify a provider-specific code path, so v1 does not use them.

## Search design

### Question design

Each query-bookmark pair is evaluated with this shape. Confirm the field names against the live API reference before implementing.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "query": "<user query>",
    "bookmark": { "title": "…", "kind": "…", "match_text": "…" }
  },
  "questions": {
    "helps": {
      "type": "noul",
      "instructions": "Would `bookmark` help the person with what `query` describes?",
      "criteria": {
        "true": "The bookmark directly serves the need in the query.",
        "false": "The bookmark is only on a related topic, or unrelated."
      }
    },
    "relevance": {
      "type": "score",
      "instructions": "How well does `bookmark` serve the need described in `query`?",
      "criteria": [
        "Unrelated to the need",
        "Same general area, but would not help with this specific need",
        "Partially addresses the need, or is one of several reasonable options",
        "Directly addresses the need"
      ]
    }
  }
}
```

A Noul near 0.5 means that yes and no are about equally likely. It does not mean medium relevance. Do not treat the two signals as interchangeable when interpreting results.

`search_answers.score` is one number derived from a four-level distribution, and the plan does not yet say how. Before Phase 11, read the Score page in the live documentation. If Jev returns a single value, record how it is defined. If the client must derive one (for example, an expected value normalized to 0 to 1), write the formula here. The full distribution is stored in either case, so the derivation can change later through replay.

The query is capped at a fixed length in the shared search input schema (configuration, for example 500 characters). The cap applies to all channels. It matters most for Milestone 4, because agents can send long queries, and the query is repeated in every chunk's state.

### Jev model limits

These limits were provided by Schalk from the TypeSafe models page:

| Property       | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Current model  | Jev 1.13 (`jev-1.13.0`)                                                |
| Price          | $0.042 per million input tokens                                        |
| Rate limits    | 250,000 tokens per second; 1,200 requests per minute                   |
| Context length | 64k tokens per request; 32k tokens for state plus the longest question |
| Input          | Text only: a string, a JSON object, or an array of text values         |

There are three consequences for the design.

First, **batch size has two budgets.** In batched mode, the state holds every bookmark in the chunk, so the state plus the single longest question must fit in 32k tokens. Everything in the request, including all questions, must fit in 64k tokens. Because every bookmark gets its own Noul and Score, the repeated question text (especially the four Score levels) grows with the number of bookmarks and competes with the state for the 64k budget. The chunker must compute both budgets from measured token counts rather than from a fixed bookmark count. Keep question wording compact, since it is paid for once per bookmark.

"Measured" needs a tokenizer, and Jev's tokenizer is not known to be available client-side. A tokenizer library in the Worker would also add bundle size and CPU time to every search. First check the live documentation for a token-counting endpoint, or for a statement about which tokenizer Jev uses. If neither exists, estimate tokens from character counts with a conservative ratio, calibrate the ratio in Phase 12 against `usage.input_tokens`, and keep a safety margin. If Jev still rejects a chunk as too large, split the chunk in half and retry it.

Second, **the requests-per-minute limit is the binding constraint for pair mode**, not cost or tokens (see Q1). The Jev client needs a client-side limiter in addition to backoff, so a burst of searches degrades gracefully instead of cascading into `429` responses.

Third, **pin the model version.** Use `jev-1.13.0` in configuration rather than `jev-latest`, so evaluation results remain comparable across runs. Model upgrades become an explicit change that is re-evaluated in Phase 12. The model reported in each response is still recorded on every `search_runs` row.

Text-only input confirms the existing design: voice is always transcribed to text before search.

### Request modes

**Batched mode** is the working default (see Q1). It places the query and a map of bookmarks keyed by ID in state, and asks one `helps` and one `relevance` question per bookmark. Each question references its bookmark by backticked path, for example `bookmarks.b_42`. Requests are chunked to fit both token budgets described above, and the chunks are issued concurrently.

**Pair mode** sends one request per bookmark. This matches the TypeSafe re-ranking cookbook and serves as the quality reference in Phase 12. Whether batching changes the probabilities compared with pair mode is unknown until Phase 12 measures it.

The mode is a configuration value recorded on each `search_runs` row.

### Ranking and thresholds

Thresholds are configuration, not code constants, and are stored on each run. The default ranking sorts by `score` and filters by `score >= score_threshold`. A parallel list computed from `noul >= noul_threshold` is logged but not shown. Which signal drives the displayed results is a Flagship flag, so the two can be compared in real use without a deploy (decision 20). Which questions are asked is also a flag. It defaults to both. After Phase 12 chooses a signal, it can be set to ask only that question, which gives back the batch capacity the second question uses. A flag change can take up to 30 seconds to reach every Cloudflare location. Every `search_runs` row therefore records the values the search actually used: the questions, the display signal, the thresholds, and the request mode.

If only one question is asked, the other column in `search_answers` has no value. Before Phase 11, decide whether `noul`, `score`, `score_probabilities`, and `score_confidence` become nullable, or whether single-question runs are logged differently. Replay must skip a signal that a run did not ask for.

**When Jev fails.** Search depends entirely on Jev, so a TypeSafe outage is a search outage. If some chunks fail after retries, show the results from the chunks that succeeded, state that the results may be incomplete, and log the run as `partial`. If all chunks fail, show an error state with a retry button and log the run as `failed`. Do not show an empty result list, because it looks like "nothing matches." A keyword fallback is in the backlog.

### Jev client

Write a small typed client with `fetch`. It sends the request, validates the response with Valibot, and retries with exponential backoff on `429` and `529`, as the API reference recommends. It also applies a client-side limiter below 1,200 requests per minute, and it estimates request size against both token budgets before sending (see "Jev model limits"). It surfaces `usage.input_tokens` for logging. The API key is only ever read server-side.

## Search page

The page is plain HTML, CSS, and JavaScript with no framework. The HTML is served by the Worker behind the session check; the CSS and JavaScript are static assets.

**Markup.** Use a `<search>` element containing a `<form>` with a visible `<label>`, an `<input type="search">`, and a submit button. Results are an `<ol>` of `<li>` items, each containing an `<article>` with a heading that wraps the link, followed by the description and a delete control (see "Deleting bookmarks"). Announce the result count through a live region. Use `role="status"` on a paragraph rather than relying on `<output>`, because announcement support for `<output>` is inconsistent across screen readers. Verify this against current support data before finalizing.

**Voice.** A microphone button next to the search input starts browser speech recognition. The button is rendered only when the page detects support for `SpeechRecognition`; check the current support data for whether Chrome still needs the `webkitSpeechRecognition` prefix, and detect both if it does. Without support, the page is the plain text search, with no disabled control and no message. The page notes that in some browsers, including Chrome, speech recognition sends audio to the browser vendor's servers. The button has an accessible name, and it shows and announces when it is listening. Recognition errors (microphone permission denied, no speech detected, or a network failure) end listening and show a short message next to the input. The transcribed text is placed in the input for the user to review before searching. It is never submitted automatically. There is no control to choose a mode, and no stored preference, until a second voice mode exists.

**CSS.** Follow the Shared First methodology. Define design tokens as custom properties registered with `@property`. Respect `prefers-color-scheme` and `prefers-reduced-motion`.

**Performance.** No blocking scripts, and one small module script. Results are rendered from JSON with DOM APIs, not `innerHTML` built from bookmark data.

## Extension

The extension uses Manifest V3 and targets Chrome and Firefox. It requests only the `activeTab` and `scripting` permissions. It needs no host permissions, no storage, and no identity permission, because it never talks to the Haystack API.

When the toolbar button is clicked, the popup runs `scripting.executeScript` against the active tab to read `document.title`, the meta description, the canonical link, and the Open Graph tags. It runs `detectSensitiveUrl` on the URL and stops with an explanation if it matches (see "Sensitive URLs"). Otherwise, it validates and truncates the values, builds the `/save` URL, opens it with `tabs.create`, and closes itself. If the page cannot be scripted (browser-internal pages, the extension store), the extension still opens `/save` with only the tab's URL and title, which are available through `activeTab`.

The Haystack origin is a build-time constant, with separate builds for local development and production.

## Save flow

`GET /save` requires a session. Without one, it redirects to Google sign-in and carries the full `/save` path and query as the return target (see "Authentication"). With a session, it validates the query parameters, renders the form with the values prefilled and editable, and never writes anything. If the URL is already saved for this user, the page says so and links to the existing bookmark instead of offering a duplicate.

`POST /save` requires a session and a same-origin `Origin` header, validates the submitted fields, computes `normalized_url`, inserts the bookmark, and renders a saved state. From Milestone 2 onward, it also starts enrichment through the on-save fast path (see "Enrichment sweep").

The form is never submitted automatically by script. A GET request that saved, or a page that auto-submitted, would let any website add bookmarks to a signed-in user's collection by navigating them to a crafted `/save` URL. The confirmation click is the protection. It also lets the user correct a bad title before enrichment runs.

Application code does not log `/save` query strings. Cloudflare's own invocation logs may record full request URLs if Workers Logs is enabled; that is acceptable for v1, and is revisited before sign-up is opened to other people (see the backlog).

The form is plain HTML and works without JavaScript. It is a `<form method="post">` with a labeled, editable title input and a labeled, editable description field. The title is prefilled from the Open Graph title, falling back to the document title and then to the URL. The description is prefilled from the Open Graph description, falling back to the meta description. The URL is shown as read-only text, next to the notice about sensitive URLs. The URL and every raw captured value (canonical URL, document title, meta description, and the Open Graph title, description, and site name) travel as hidden inputs, so `POST /save` receives them unchanged.

On submission, the edited values are stored as the bookmark's `title` and `description`, and the raw captured values are stored alongside them as evidence for enrichment. The recent saves list and the search result cards show the confirmed `title` and `description`. There is no editing after saving.

## Sensitive URLs

Some URLs are secrets in themselves: pre-signed download links, links carrying access tokens, password reset and sign-in links, invitations, and "anyone with the link" shares. Haystack must never store them. Beyond being stored, a saved URL is sent to third parties during enrichment (the LLM provider, TypeSafe, and GitHub for repositories), so a secret URL would leave Haystack entirely.

Detection can only be partial. Many capability URLs look like ordinary URLs, so the protection has two parts.

**Telling users.** The save form shows a short notice next to the URL, stating that links containing access tokens, private shares, or sign-in and reset links must not be saved, and why. The same notice appears once on the recent saves page (and later the search page) as part of the page content, not as a dismissible banner. Keep the wording short and concrete; it is part of the interface, not a legal notice.

**Refusing recognizable patterns.** A pure function, `detectSensitiveUrl(url)`, lives in `packages/schemas` next to the normalization function. It checks an explicit, narrow list of high-confidence signals and returns the matched reason, or nothing. The initial list covers:

- query parameters used by pre-signed storage URLs, such as `X-Amz-Signature`, `X-Amz-Credential`, `X-Goog-Signature`, and the `sig` plus `se` pair used by Azure shared access signatures
- query parameters or fragments carrying credentials, such as `access_token`, `id_token`, `refresh_token`, `api_key`, `apikey`, `password`, and `client_secret`
- credentials embedded in the URL itself (`https://user:password@host`)

The list is deliberately narrow, because a match is a hard refusal with no override. Broad signals such as a parameter named `token` or `code` appear in too many legitimate URLs (documentation sites, OAuth guides) to refuse outright. Additions to the list are made in code, each with a test case, including a test proving that a similar legitimate URL is still accepted.

The check runs in three places:

1. **In the extension, before `/save` is opened.** A flagged URL never leaves the browser. The popup shows the reason and does not open the save form.
2. **On `GET /save`.** For URLs that arrive by other routes (a hand-built link, later a bookmarklet or share target), the page shows the refusal instead of the form.
3. **On `POST /save`.** The server check is the authoritative one, since the other two can be bypassed.

The refusal message states the reason in plain language (for example, "This link contains a signed access key, so it could let anyone who has it download the file") and does not echo the full URL back into the page.

The deterministic check is part of Milestone 1.

### Probabilistic check with Jev (Milestone 2)

The deterministic list cannot recognize capability URLs that carry no telltale parameter, such as a private document share. Jev adds a probability for those. Because the question is whether a URL is safe to send to third parties, Jev must never see the raw URL.

**Redaction.** A pure function, `describeUrlForJudgment(url, title)`, in `packages/schemas` produces the state sent to Jev: the scheme and host, the path with each segment that looks random (long, high in digits or mixed case, or otherwise not word-like) replaced by a placeholder describing its shape, and the query parameter and fragment parameter _names_ with a shape placeholder for each value. Values are never included. The captured page title is included, since it is useful evidence and is not a secret. For example:

```json
{
  "host": "docs.google.com",
  "path": "/document/d/<random:44>/edit",
  "query": { "usp": "<word:7>" },
  "title": "Q3 planning (draft)"
}
```

The redaction must err toward masking. A test suite proves that no query value, fragment value, or random-looking path segment from a set of fixture URLs ever appears in the output.

**The question.** One Noul: "Would this link grant access to something private, such as a document, file, account, or invitation, to anyone who has it?" The criteria describe a true answer as a link that works as a key (shares, signed links, invitations, sign-in and reset links, tokenized links) and a false answer as a link to a public page. Write the final wording after reading the Noul page in the live documentation.

**Policy, in code.** The deterministic match remains a hard refusal. A noul at or above `SENSITIVE_WARN_THRESHOLD` (configuration) is a warning, not a refusal, because a probability will produce false positives. If Jev is unavailable, saving proceeds on the deterministic check alone, with `sensitivity_noul` left empty, and the enrichment gate checks the bookmark later. A TypeSafe outage must never block saving.

**On the save form.** `GET /save` runs the check before rendering. Above the threshold, the form shows a warning explaining why the link looks private and adds a required checkbox: "This link does not give access to anything private." `POST /save` runs the check again rather than trusting anything from the form, and rejects the submission if the result is above the threshold and the checkbox is not ticked. The stored bookmark records the noul, when it was checked, and the acknowledgment.

**As an enrichment gate.** The enrichment module runs the check as its first step for any bookmark whose `sensitivity_noul` is empty, which covers everything saved in Milestone 1 and anything saved during a Jev outage. A bookmark at or above the threshold without an acknowledgment becomes Held: it is not sent to GitHub, to the `kind` question, or to the LLM provider. A Held bookmark does not count as a failed attempt.

**Reviewing Held bookmarks.** A page at `/held` lists them with their titles and hosts. The same page also lists Failed bookmarks with a retry action (see "Enrichment sweep"). Each Held bookmark has two actions: release (the user confirms the link is not private, which sets the acknowledgment and lets the sweep enrich it) or delete (which removes the bookmark and everything attached to it). Both are POST actions with the usual session and `Origin` checks. Deletion here uses the same endpoint as everywhere else (see "Deleting bookmarks").

**Calibration.** Stored bookmarks keep their noul and acknowledgment, which shows how often the warning fired on links the user considered fine. When a warning is shown but the bookmark is never saved, log only the noul and the fact that a warning was shown, never the URL.

## Deleting bookmarks

A bookmark can be deleted by its owner from the recent saves list (Milestone 1), the search results (Milestone 3), and the review page at `/held` (Milestone 2). All three use one endpoint, `POST /bookmarks/:id/delete`, with the usual session and `Origin` checks.

The server looks the bookmark up by ID _and_ the session's user ID in the same query. If there is no match, it returns 404, whether the bookmark does not exist or belongs to someone else, so the response never reveals that another user's bookmark exists. The delete button is only rendered for bookmarks the current user owns; in v1 every bookmark a user can see is their own, but the server check is what enforces it.

Deletion is permanent and removes the bookmark with its enrichments, failure records, and search answers. The URL can be saved again afterward. Search runs themselves are kept, so the evaluation harness must tolerate labeled bookmark IDs that no longer exist.

**Interaction.** Each result card and list item has a real `<button>` inside a small `<form method="post">`, with an accessible name that includes the title (for example, "Delete Vitest browser mode guide"), so a screen reader user hearing a list of delete buttons knows which is which. Without JavaScript, the button leads to a confirmation page with a single confirm button. With JavaScript, confirmation happens in a native `<dialog>` opened with `showModal()`, which provides focus trapping and Escape handling. After deletion, the item is removed, focus moves to the next item (or to the list heading if it was the last one), and the live region announces the deletion.

Deletion is not exposed to agents in Milestone 4. The MCP and WebMCP tools are search-only.

## Agent access (Milestone 4)

Both agent surfaces call the same `searchBookmarks(userId, query, { channel, inputMode })` service as the web page, so ranking, thresholds, logging, and the exclusion of Held bookmarks behave identically. `channel` is recorded on each search run, so agent searches can be analyzed separately from human searches.

**Tool design.** One tool, `search_bookmarks`, takes a natural-language `query` string and returns the ranked results: title, description, URL, and kind. It does not return enrichment internals, probabilities, or anything else from the database. The tool description tells the agent what Haystack contains and that results are the signed-in user's own saved resources. The result shape is defined once, as a Valibot schema in `packages/schemas`, and shared by both surfaces.

**WebMCP.** The search page registers the tool with the browser's WebMCP API when it is available (feature-detected, see Q9). The tool calls the existing `/api/search` endpoint with the page's session, so it needs no new authentication and only works while the user is signed in with the page open. Because WebMCP is in-browser and human-present, it is the lower-risk surface and is built first.

**Remote MCP server.** A `/mcp` endpoint on the same Worker implements the 2026-07-28 specification with its stateless core: there is no initialization handshake and no session, so every request is self-contained and handled like any other Worker request. It exposes only the search tool. Authorization follows the MCP specification (see Q8). Each MCP request resolves to a Haystack user, is checked against `ALLOWED_EMAILS` like a session, and is subject to a per-user rate limit, because agents can issue searches far faster than a person.

Write tools (saving and deleting through agents) are out of scope for Milestone 4 and listed in the backlog.

**Untrusted text in tool results.** Search-only does not mean the risk is small for the user. Titles and descriptions in tool results come from web pages, and the agent that reads them may have other tools, such as email, file access, or a shell. A bookmarked page with an injected instruction in its description then reaches that agent. Haystack cannot control the agent. It can return results as structured data (fields, not prose), keep descriptions length-capped, and state in the tool description that the result fields are third-party page text and are not instructions. Record this risk in the documentation for connecting an MCP client.

## Authentication

### Site sign-in

The site uses the Google OpenID Connect authorization code flow with PKCE and a `state` parameter. The callback exchanges the code, verifies the ID token (issuer, audience, expiry, signature against Google's published keys, and `email_verified`), then checks the email against the `ALLOWED_EMAILS` allowlist. Users are keyed on the `sub` claim, not the email address, because the email address can change.

On success, the server creates a session with a random ID, stores only its SHA-256 hash in `sessions`, and sets the raw ID in a cookie with the `__Host-` prefix and the `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/` attributes. Every state-changing request also checks the `Origin` header as CSRF protection alongside `SameSite`. Sign-out deletes the session row and clears the cookie.

Sessions last 30 days and slide: a request in the second half of a session's life extends its expiry, so the database is not written on every request. Every request also checks the session user's email against `ALLOWED_EMAILS`, so removing an address takes effect immediately rather than when the session expires. The allowlist check needs the email stored on the user row, which is refreshed at each sign-in. Expired sessions are deleted by the scheduled handler once it exists in Milestone 2. Until then, expired rows are ignored by the session lookup.

Every page and API route except `/auth/*` requires a session. Unauthenticated page requests redirect to sign-in, and unauthenticated API requests return 401. Static assets (CSS, JavaScript, fonts, images) are public, and must never contain user data.

By default, Workers serves a matching static asset without running the Worker. Keep all HTML out of the assets directory so that every page goes through the Worker. If an HTML route must ever live in the assets directory, configure Wrangler to run the Worker first for that path (verify the current `run_worker_first` configuration) and add a test proving it redirects without a session.

### Return targets

When an unauthenticated request needs sign-in, the path and query to return to are stored server-side with the OAuth `state`, not passed through as a free-form parameter. They go in the `auth_flows` table together with the PKCE verifier. A cookie is not used for this, because a `/save` return target holds the captured page data and can exceed the roughly 4 KB that browsers allow for one cookie. An `auth_flows` row is used once, deleted in the callback, and rejected after it expires. The session lookup deletes expired rows it finds, and the scheduled handler cleans up the remaining ones from Milestone 2. Before redirecting after sign-in, the server confirms that the target is a relative path on the Haystack origin. Anything else falls back to `/`. This prevents the sign-in flow from becoming an open redirect.

### Rules that hold everywhere

No endpoint accepts a `user_id` from the client. Session IDs are compared by hash lookup, not string equality on raw values. Every query that reads or writes user data filters by the authenticated `user_id`, and a test for each endpoint proves that one user cannot read another user's bookmarks or search logs.

## Secrets and configuration

`.env.schema` declares every variable for varlock, with sensitive values resolved from 1Password. Deploy and local development go through `varlock-wrangler`, which passes secrets through a named pipe and stdin rather than through process arguments.

`apps/worker/wrangler.jsonc` declares the secret names in `secrets.required`. Deploy fails if a required secret is missing, so the list grows with each milestone instead of listing everything up front. A secret is added to the list in the same change that first uses it.

```jsonc
{
  // Milestone 1: Capture
  "secrets": {
    "required": ["GOOGLE_CLIENT_SECRET"],
  },
  // Milestone 2: Enrichment adds (the TypeSafe key also powers the sensitivity check)
  //   "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"
  //   (plus the AI Gateway token, if the gateway is configured to require one)
  //
  // Post-v1, with the OpenAI and OpenRouter adapters:
  //   "OPENAI_API_KEY", "OPENROUTER_API_KEY"
}
```

Non-secret static configuration, such as the base URLs for Jev, the LLM providers, GitHub, and Google (so integration tests can point them at fixtures), the AI Gateway account and gateway IDs, the model chosen for each provider, the sweep frequency and attempt limit, `SENSITIVE_WARN_THRESHOLD`, `GOOGLE_CLIENT_ID`, and `ALLOWED_EMAILS`, goes in `vars`. Never run `wrangler secret put` with a value in the command line.

**Runtime switches** are Flagship flags (decision 20): the search questions (`both`, `noul`, or `score`), the display signal, the Noul and Score thresholds, the request mode, whether the sweep is enabled, and the sweep batch size. These are the settings that change during evaluation and operation. `SENSITIVE_WARN_THRESHOLD` and `ALLOWED_EMAILS` stay in `vars` on purpose. Changing the sensitivity threshold changes which bookmarks are Held, and changing the allowlist changes who can sign in, so both should be reviewed changes that go through a deploy.

The Worker reads flags through a binding, declared as follows (field names checked against the Wrangler 4.147.0 configuration schema):

```jsonc
{
  "flagship": [{ "binding": "FLAGS", "app_id": "<APP_ID>" }],
}
```

One configuration module reads every flag once per request, or once per sweep run, and passes the values on. No other code calls the binding. Each flag's default value is a constant in that module, so the defaults are reviewed in code. The binding never throws, and it returns the default when evaluation fails, so a Flagship outage means the Worker runs with those defaults. The defaults are the safe values: both questions, the Score signal, batched mode, and the sweep enabled with a small batch size.

## Testing strategy

**Unit and integration tests** run with `vp test` (Vitest 5, bundled with Vite+). See Q10 (a) for the reasons behind this approach. Pure modules have plain unit tests. Integration tests start the Worker in the local Workers runtime with Wrangler's `createTestHarness`, and use a real local D1 binding. Before running, they apply the same migration files as production with the harness's `applyD1Migrations`, so the tested schema is always the migrated schema. Jev, LLM, GitHub, and Google calls go to a fixture Worker in the same harness that serves recorded responses. The base URLs for those services are `vars`, which the tests override. No unit test calls a live paid API. Recorded fixtures can drift from the live APIs, so `evals/` also contains a small contract check. It sends one live request to each external API, validates the response with the same Valibot schemas the clients use, and runs before each milestone deploy.

**Markup validation.** Haystack has no `.html` files, because the Worker renders every page (decision 1). The `html-validate "**/*.html"` script therefore has no input, and it is not part of `pnpm quality`. Integration tests render each page through the test harness and validate the result with html-validate's programmatic API and the existing `.htmlvalidate.json` configuration (issue #3).

**End-to-end tests** use Playwright for the search page and the save form, including keyboard-only operation and an axe accessibility scan. The extension is tested in Chromium by launching a persistent context with `--load-extension`. Playwright cannot load Firefox extensions, so Firefox is covered by a documented manual check using `web-ext run`.

**Evaluations** live in `evals/` and are separate from the test suite. They run only when explicitly invoked with a live key. The labeled dataset is a set of queries, each with the bookmark IDs that should and should not match. It starts with roughly 30 queries written by Schalk against his own bookmarks.

## Milestones and phases

Each phase lists its tests first. A phase is done when its tests pass and its acceptance criterion holds. Each milestone ends with a production deploy.

### Milestone 1: Capture

Goal: save bookmarks from the extension into production, so the collection starts growing. There is no enrichment and no search in this milestone.

#### Phase 0: Scaffold

Q10 is resolved. The Vite starter files and their `dev`, `build`, and `preview` scripts were removed in #2. Phase 0 is split into issues #5 to #8. #5 sets up the workspace layout, TypeScript, Wrangler, the Cloudflare Vite plugin, and the test harness described in Q10 (a). No Phase 0 issue covers Playwright yet. It is first needed for the axe scan in Phase 4. The remaining steps set up Drizzle with the D1 driver and drizzle-kit, varlock with 1Password, `varlock-wrangler`, the `secrets.required` declaration, and the D1 database with its initial migration generated from the Drizzle schema. Milestone 1 needs only the `users`, `sessions`, `auth_flows`, and `bookmarks` tables. The enrichment and search tables arrive in their own milestones through reviewed migrations.

Tests: a smoke test that the Worker responds through the test harness, a test that the migrated database contains the expected tables after `applyD1Migrations`, a spike test proving that the Worker can call a fixture Worker through a base URL set in `vars` (see Q10 (a)), a test that triggers the `scheduled()` handler through the harness, a spike test of the Flagship binding under the harness that answers Q13's local behavior question, a test that the static assets directory contains no HTML files (run against the build output, not the source tree), and `vp check` and the `quality` script passing on the scaffold.
Acceptance: `varlock-wrangler dev` runs locally with `GOOGLE_CLIENT_SECRET` resolved from 1Password, no secret value appears in process arguments, and a migration generated by drizzle-kit applies cleanly with `wrangler d1 migrations apply`.

#### Phase 1: Capture payload schema

Write the Valibot schema for the capture payload, the URL normalization function, and `detectSensitiveUrl`, all shared from `packages/schemas`.

Tests: valid and invalid payloads, length caps, trimming, rejection of non-HTTP schemes for the URL and the canonical URL, a table of normalization cases (case, default ports, fragments, tracking parameters, parameter order, trailing slashes), and a table of sensitive URL cases: every signal in the list is detected, in the query string, the fragment, and with differing case, embedded credentials are detected, and similar legitimate URLs (for example, documentation pages with `token` or `code` parameters) are accepted.
Acceptance: the Worker and the extension import the schema from one package.

#### Phase 2: Authentication

Implement Google sign-in for the site, sliding sessions, sign-out, the authentication middleware with the per-request allowlist check, and return targets. Q5 is resolved: use Arctic for the Google flow, with hand-written sessions.

Tests: an invalid `state` or PKCE verifier is rejected, an ID token with the wrong audience or issuer or an expired one is rejected, an email not on the allowlist is rejected, a user is matched by `sub` even when the email changes, the session cookie carries the required attributes, a cross-origin POST is rejected, a return target is preserved through sign-in, an absolute or protocol-relative return target falls back to `/`, an expired session is rejected, a session in the second half of its life is extended, and a user removed from `ALLOWED_EMAILS` is rejected on their next request with an existing session, an `auth_flows` row cannot be used twice, an expired `auth_flows` row is rejected, and a return target longer than 4 KB survives sign-in. Stub Google's token and key endpoints with fixtures.
Acceptance: Schalk can sign in to the site with Google, and a non-allowlisted account cannot.

#### Phase 3: Save flow

Implement `GET /save` and `POST /save` as described under "Save flow." In this milestone, `POST /save` inserts the bookmark and does nothing else.

Tests: GET without a session redirects to sign-in and returns to the same prefilled URL afterward, GET never writes to the database, GET with invalid parameters shows a validation message rather than an error page, GET for an already-saved URL, including one that differs only by tracking parameters or a fragment, links to the existing bookmark, the title and description are prefilled by the fallback rules, edited values are stored as `title` and `description` while the raw captured values are stored unchanged, POST without a session or with a cross-origin `Origin` is rejected, a `javascript:` or `data:` URL is rejected, the same URL can be saved independently by two users, the user ID comes from the session and never from the form, application code does not log `/save` query strings, a sensitive URL is refused on GET and on POST without echoing the URL, the form shows the sensitive URL notice, two concurrent submissions of the same URL produce one bookmark and an "already saved" result rather than an error, a title containing markup is rendered as text with the Content Security Policy header present, and the rendered save form passes html-validate (issue #3).
Acceptance: opening a hand-built `/save` URL while signed in, then confirming, creates a bookmark under the right user with the confirmed title and description. The form works with JavaScript disabled.

#### Phase 4: Recent saves list

Build a server-rendered page at `/` listing the signed-in user's bookmarks, newest first, with a delete control on each item (see "Deleting bookmarks"). This makes deletion available from Milestone 1, so a link saved by mistake can be removed straight away. Each item shows the confirmed title as a link to the resource, the URL, and the date saved. It uses a heading and a semantic list, and works without JavaScript. The search page replaces it at `/` in Milestone 3, and the list may move to its own route then.

Tests: the sensitive URL notice is present, only the signed-in user's bookmarks appear, the order is newest first, an empty collection shows a helpful empty state, and the page passes an axe scan. Deletion: the owner can delete a bookmark, deleting another user's bookmark returns 404 and changes nothing, a cross-origin delete is rejected, the URL can be saved again after deletion, the delete button's accessible name includes the title, the no-JavaScript confirmation page works, and with JavaScript the dialog confirms, focus moves to the next item, and the deletion is announced.
Acceptance: a bookmark saved through `/save` appears at the top of the list and can be deleted from it.

#### Phase 5: Extension

Build the popup capture, validation and truncation, and the `/save` URL builder. Q4 must be resolved first.

Tests: unit tests for the extraction function against fixture documents, for truncation to the shared caps, for the fallback on pages that cannot be scripted, and for a sensitive URL stopping the flow before any tab is opened. A Playwright test loads the extension, opens a fixture page, clicks the action, and asserts that the prefilled `/save` form opens.
Acceptance: in Chrome (automated) and Firefox (manual check with `web-ext run`), the save form opens prefilled from the current page.

#### Phase 6: Capture deploy

Deploy to a `workers.dev` subdomain with `varlock-wrangler deploy`, apply the migrations remotely, register the Google OAuth redirect URI for that origin, build the extension against the production origin, and run the Playwright suite against production. Write down the D1 restore procedure (see "Data model") before the first real bookmark is saved.

Daily use in Firefox needs a signed extension, because release builds of Firefox install unsigned extensions only temporarily. Sign it through addons.mozilla.org as an unlisted (self-distributed) add-on. An unlisted add-on is not published, so Q6 does not block it, but confirm that the name can change later. In Chrome, loading the unpacked extension in developer mode is enough for v1.

Acceptance: Schalk saves real bookmarks from the extension in daily use, and they appear in the recent saves list.

### Milestone 2: Enrichment

Goal: every existing and future bookmark gets validated enrichment. The first backfill processes everything saved during Milestone 1.

#### Phase 7: Enrichment module

Add the `enrichments` and `enrichment_failures` tables and the three sensitivity columns on `bookmarks` through a reviewed migration. Implement `describeUrlForJudgment` and the Jev sensitivity check, and make the sensitivity gate the module's first step. Q7 must be resolved first. Write the Valibot schemas for the enrichment output and Jev responses. Implement the GitHub client, the Jev client with the `kind` question, the provider interface with the Anthropic and AI Gateway adapters, validation with a single retry, `match_text` derivation, and the atomic write of the enrichment row together with the removal of its failure record. A Jev failure after retries counts as an enrichment failure, like an LLM failure. The module takes one bookmark and returns an outcome. It knows nothing about how it was invoked.

Tests: the redaction never outputs a query value, fragment value, or random-looking path segment from the fixture URLs; the gate runs only when `sensitivity_noul` is empty; a bookmark above the threshold without an acknowledgment becomes Held and makes no GitHub, `kind`, or LLM call; an acknowledged bookmark above the threshold is enriched; a Held bookmark does not count as a failed attempt; and fixture-driven tests for every other branch, including a GitHub failure falling back to the captured payload, invalid LLM output being retried and then recorded as a failure, a Jev `429` being retried, a transient failure recording the error without incrementing `attempts`, a permanent failure incrementing `attempts`, a GitHub issue URL being enriched as the issue with the repository as context, a reserved GitHub route not being treated as a repository, an enrichment with an empty `use_cases` list passing validation, `match_text` for an empty `use_cases` list containing no placeholder text, `match_text` being deterministic, a second insert for the same bookmark and schema version doing nothing, and the enrichment row and the failure record change being written together or not at all.
Acceptance: calling the module on a fixture bookmark produces a valid enrichment row, and the bookmark's derived state is Current.

#### Phase 8: Enrichment sweep

Implement `enrichPending`, the `match_text` refresh, expired session cleanup, the `scheduled()` handler, the Cron Trigger, and the configuration for the batch size, the attempt limit, the frequency, and the enabled flag, as described under "Enrichment sweep." The enabled flag and the batch size are Flagship flags, and the frequency and attempt limit are `vars`. Q3 and Q13 must be resolved first.

Tests: the derived states are computed correctly for each case in the state table, only Pending and Outdated bookmarks are selected, bookmarks at the attempt limit for the current version are skipped, raising `schema_version` resets the attempt count, one failing bookmark does not stop the batch, a second run with nothing outstanding makes no provider calls, raising `schema_version` makes previously enriched bookmarks eligible again while search can still use their older enrichment, raising `match_text_version` rewrites `match_text` without any provider call, expired sessions and `auth_flows` rows are deleted, the batch size is respected, a bookmark within its backoff window is skipped, a run stops early when its first calls all fail transiently, and the disabled flag makes the handler do nothing.
Acceptance: `wrangler dev --test-scheduled` drains a local backlog of fixture bookmarks over several runs.

#### Phase 9: Backfill and on-save enrichment

Deploy with the sweep disabled. Enable it for a single run with a batch size of five, and review those enrichments. Adjust the prompt or the schema if needed, raising `schema_version` if the output shape changes. Then raise the batch size and let the sweep drain the backlog. Review any Held bookmarks on `/held` as they appear. Once the backlog is empty, add the Jev sensitivity check to `GET /save` and `POST /save` with the warning and required acknowledgment, add the on-save fast path to `POST /save` through `ctx.waitUntil`, and lower the sweep frequency to its steady-state setting.

Tests: `/held` lists only the signed-in user's Held and Failed bookmarks, retry clears the failure record for the current version and makes the bookmark eligible for the sweep, release sets the acknowledgment and makes the bookmark eligible for the sweep, delete removes the bookmark and its related rows, both actions reject cross-origin requests, the save form shows the warning and requires the checkbox above the threshold, `POST /save` re-runs the check and rejects an unacknowledged submission above the threshold, a Jev outage lets the save proceed with the noul left empty, a warning shown without a save logs no URL, the fast path does not delay the saved response, and a fast-path failure leaves the bookmark eligible for the sweep.
Acceptance: every bookmark in production is Current, Held and reviewed, or Failed with a recorded error, and a newly saved bookmark is usually enriched within seconds.

### Milestone 3: Search

Goal: natural-language search over the enriched collection, with the logging needed to tune it.

#### Phase 10: Search page shell

Add the `search_runs` and `search_answers` tables through a reviewed migration. Build the search page with the search form, the results list with a delete control on each result, and the live region, with typed search only. Use a stub API.

Tests: Playwright tests for keyboard operation, focus management after search and after deleting a result, the result count being announced, and an axe scan with no violations.
Acceptance: the page is usable with a keyboard and a screen reader against the stub.

#### Phase 11: Search API

Implement the `searchBookmarks(userId, query, { channel, inputMode })` service, independent of HTTP so that Milestone 4 can reuse it, and `/api/search` as a thin caller of it. The service covers candidate loading, the Jev search questions in the mode chosen by Q1, ranking, and full logging to `search_runs` and `search_answers`. Record a click through a small endpoint called when a result link is followed.

Tests: the service works without any HTTP request object, the channel is recorded, every candidate is logged including those below the threshold, a deleted bookmark disappears from results and its search answers are removed, the thresholds are read from configuration, batch chunking respects both the 32k state-plus-longest-question budget and the 64k request budget, the limiter holds requests under the per-minute limit, only bookmarks with at least one enrichment are candidates, Held bookmarks are never candidates, each candidate uses its most recent enrichment, an empty collection returns an empty result, a query over the length cap is rejected, a chunk rejected as too large is split and retried, a partial Jev failure shows the successful results with an incomplete notice and is logged as `partial`, a full Jev failure shows an error state rather than an empty list and is logged as `failed`, and the web channel logs `input_mode`.
Acceptance: a real search from the page returns ranked cards, and the logs contain both signals for every candidate.

#### Phase 12: Evaluation harness

Write the labeled query set against the real collection, a replay script that re-ranks logged answers under any threshold without calling Jev, and a comparison script that runs the same labeled queries in pair mode and batched mode.

Outputs: precision and recall at several thresholds for Noul and for Score, the per-pair difference between pair and batched probabilities, the measured tokens per bookmark in batched mode, which sets the real chunk size, the calibrated characters-per-token ratio for the chunker's estimate, p95 search latency against collection size, which sets the shortlisting trigger (Q11), and a comparison of `match_text` derivations with and without `technologies`, `topics`, and `problems_solved`. Pair-mode evaluation runs must stay under the 1,200 requests per minute limit.
Acceptance: Schalk can choose a default signal, a default threshold, and a request mode based on data, and can decide whether search keeps asking both questions. Each choice is applied by changing a Flagship flag, without a deploy.

#### Phase 13: Voice

Add the microphone button and browser speech recognition behind feature detection, as described under "Search page."

Tests: Playwright replaces the speech recognition constructor with a stub through an init script, because tests cannot use a real microphone. The button is not rendered when the API is missing; the button's accessible name and listening state are announced; a stubbed result fills the input without submitting it; each stubbed error (permission denied, no speech, network) ends listening and shows its message; and the run logs `web-speech` as `input_mode` when the query came from speech and `typed` when the user typed it or replaced the transcript.
Acceptance: in Chrome, a spoken query fills the input and searches after confirmation, and `input_mode` is logged on each run.

#### Phase 14: Search release

Deploy Milestone 3 and run the Playwright suite against production. Once Q6 is resolved, move to the custom domain: update the Google OAuth redirect URIs and rebuild the extension with the new origin.

Acceptance: the end-to-end flow works in production: save from the extension, enrichment, then search.

### Milestone 4: Agent access

Goal: agents can search the user's bookmarks, first from the browser through WebMCP, then from any MCP client. Search only.

#### Phase 15: WebMCP search tool

Define the `search_bookmarks` tool's input and result schemas in `packages/schemas`. Register the tool on the search page when the WebMCP API is available, calling `/api/search` with the page's session and recording `channel` as `webmcp`. Q9 must be resolved first.

Tests: the tool is not registered when the API is unavailable, the tool's results match the web search for the same query, results contain only title, description, URL, and kind, Held bookmarks never appear, and the run is logged with the `webmcp` channel. Use the browser's WebMCP testing interface where available, otherwise test the tool's execute function directly.
Acceptance: an in-browser agent can find a bookmark by describing it.

#### Phase 16: MCP authorization

Implement authorization for MCP clients as decided in Q8, with Google sign-in as the identity step and the `ALLOWED_EMAILS` check applied to every request. Q8 must be resolved first.

Tests: follow the authorization section of the 2026-07-28 specification as the checklist, including the issuer and client validation it requires, and additionally: a request without a valid token is rejected, a token for a user removed from `ALLOWED_EMAILS` is rejected, and a revoked token is rejected.
Acceptance: an MCP client completes authorization through Google sign-in and receives a token scoped to one Haystack user.

#### Phase 17: Remote MCP search server

Implement `/mcp` on the stateless 2026-07-28 specification with the search tool only, calling `searchBookmarks` with the `mcp` channel, and add a per-user rate limit. Use the official TypeScript SDK if its current release supports this specification revision on Workers; otherwise implement the small required surface directly.

Tests: required discovery and tool listing work without any prior request, a tool call works as a single self-contained request, a request for any tool other than search is rejected, results match the web search for the same query, the rate limit applies per user, and the run is logged with the `mcp` channel.
Acceptance: Claude and at least one other MCP client can search Haystack by describing a bookmark.

#### Phase 18: Agent access release

Deploy Milestone 4, document how to connect an MCP client, and review the search logs by channel after a week of use.

Acceptance: agent searches appear in the logs under their channels, and the thresholds chosen in Phase 12 still hold for agent-written queries, or a separate threshold per channel is set.

## Post-v1 backlog

Candidate shortlisting with Vectorize before Jev reranking, which becomes necessary sooner if Phase 12 favors pair mode. The comparison of AI Gateway and OpenRouter, measuring cost, latency, and enrichment quality. A bookmarklet that opens the same `/save` URL, for browsers without the extension. A web app manifest with `share_target` pointing at `/save`, so an installed Haystack appears in the system share sheet where the Web Share Target API is supported (verify current support; Safari on iOS is believed not to support it). A faster confirm step if the review click starts to feel slow, which must still require a user action. Opening sign-up beyond the allowlist, which needs per-user rate limits and spending caps on enrichment and search first, and a decision about whether Cloudflare invocation logs may contain other users' saved URLs. Editing bookmarks after saving. MCP and WebMCP write tools (saving and deleting), with explicit user confirmation through WebMCP's user interaction API and MCP's multi round-trip requests. A server-side capture fallback for bookmarks saved from entry points that cannot read the page, such as a share target. Whisper transcription on Workers AI as a second voice mode for browsers without Web Speech: an `/api/transcribe` endpoint with a session check and an audio size limit, recording with `MediaRecorder`, and the mode control that v1 does not have. A keyword search fallback with SQLite FTS5 over `title` and `match_text` (verify that D1 supports FTS5), used when Jev is unavailable, and possibly as a cheaper shortlisting step than Vectorize. Account deletion that removes a user and all their data, which is needed before sign-up opens (in v1, `bookmarks.user_id` and `search_runs.user_id` have no `ON DELETE` behavior).

## References

- TypeSafe documentation index: https://docs.typesafe.ai/llms.txt
- TypeSafe HTTP API: https://docs.typesafe.ai/api.md
- TypeSafe models and limits: provided by Schalk from the TypeSafe models page (Jev 1.13)
- TypeSafe re-ranking cookbook: https://docs.typesafe.ai/cookbooks/rerank_typesafe.md
- TypeSafe skill: https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md
- Wrangler `secrets` configuration property: https://developers.cloudflare.com/changelog/2026-03-24-secrets-config-property
- varlock Cloudflare integration: https://github.com/dmno-dev/varlock
- Model Context Protocol specification, 2026-07-28 revision: https://modelcontextprotocol.io/specification
- WebMCP (W3C Web Machine Learning Community Group): https://github.com/webmachinelearning/webmcp
- Cloudflare Flagship: https://developers.cloudflare.com/flagship/
- Cloudflare `cf` CLI: https://developers.cloudflare.com/cf/ and the launch post https://blog.cloudflare.com/cloudflare-cf-cli-launch/
- Moving from Wrangler to `cf`: https://developers.cloudflare.com/cf/wrangler/
