// Tables for Milestones 1 to 3. See "Data model" in plans/haystack-v1-implementation-plan.md.
// Timestamps are INTEGER epoch milliseconds, set by application code. IDs come from
// crypto.randomUUID(), also set by application code.
import { type SQL, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  type SQLiteColumn,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/**
 * `column IN ('a', 'b', …)`, for a CHECK constraint that accepts only `values`. The same list
 * gives the column its type, so the two cannot drift apart. The values are this file's own
 * constants, written into the SQL as they are, so none may contain a quote.
 */
function isOneOf(column: SQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Stable Google account ID. Never key on email.
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const sessions = sqliteTable("sessions", {
  // SHA-256 of the session ID. The raw ID lives only in the cookie.
  idHash: text("id_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const authFlows = sqliteTable("auth_flows", {
  // SHA-256 of the OAuth state. Single use.
  stateHash: text("state_hash").primaryKey(),
  // PKCE verifier.
  codeVerifier: text("code_verifier").notNull(),
  // Relative path and query, validated before redirect.
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // As submitted, minus tracking parameters (stripTrackingParameters).
    url: text("url").notNull(),
    // See "URL normalization". Used to find duplicates.
    normalizedUrl: text("normalized_url").notNull(),
    // Title and description as confirmed on the save form.
    title: text("title").notNull(),
    description: text("description"),
    // Raw captured values, kept as enrichment evidence.
    canonicalUrl: text("canonical_url"),
    capturedTitle: text("captured_title"),
    capturedDescription: text("captured_description"),
    ogTitle: text("og_title"),
    ogDescription: text("og_description"),
    ogSiteName: text("og_site_name"),
    // Milestone 2+ (#79): true when a canonical URL that detectSensitiveUrl flags was dropped,
    // false when none was, NULL when the save did not record it. Never the URL itself.
    sensitiveCanonicalDropped: integer("sensitive_canonical_dropped", { mode: "boolean" }),
    // Milestone 2+: Jev probability that the URL grants private access. NULL means not yet checked.
    sensitivityNoul: real("sensitivity_noul"),
    sensitivityCheckedAt: integer("sensitivity_checked_at"),
    // Set when the user confirms the link is not private (save form or /held).
    sensitivityAcknowledgedAt: integer("sensitivity_acknowledged_at"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [unique().on(table.userId, table.normalizedUrl)],
);

// Milestone 2. See "Enrichment state is derived, not stored" in the plan: a bookmark's state
// comes from these rows, so neither table has a status column.
export const enrichments = sqliteTable(
  "enrichments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    // The JSON columns are typed `unknown`, because the database does not enforce their shape.
    // They are validated with Valibot when read.
    kindProbabilities: text("kind_probabilities", { mode: "json" }).notNull(),
    // The full validated enrichment.
    data: text("data", { mode: "json" }).notNull(),
    matchText: text("match_text").notNull(),
    matchTextVersion: integer("match_text_version").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  // One enrichment per version, so when the save's fast path and the sweep enrich the same
  // bookmark at once, the second insert does nothing.
  (table) => [unique().on(table.bookmarkId, table.schemaVersion)],
);

// At most one record per bookmark and schema version. Writing an enrichment at that version
// deletes it. See "Enrichment sweep" in the plan.
export const enrichmentFailures = sqliteTable(
  "enrichment_failures",
  {
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull(),
    // Permanent failures only. At the attempt limit, the bookmark is Failed.
    attempts: integer("attempts").notNull(),
    // Every failure, transient or permanent, since the record was created. The sweep's backoff
    // window grows with it. A success deletes the record, so the count starts again from zero.
    consecutiveFailures: integer("consecutive_failures").notNull(),
    lastError: text("last_error").notNull(),
    lastAttemptAt: integer("last_attempt_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bookmarkId, table.schemaVersion] })],
);

// Milestone 3. See "Data model" and "Ranking and thresholds" in the plan. Every search is
// logged, including one that fails, so that a replay can re-rank the answers under any
// threshold without asking Jev again.

// `eval` is Phase 12's evaluation runs, so that a replay can include or exclude them.
const SEARCH_CHANNELS = ["web", "webmcp", "mcp", "eval"] as const;
// The web channel only. `whisper` is reserved for the backlog item, so adding it needs no
// table rebuild.
const SEARCH_INPUT_MODES = ["typed", "web-speech", "whisper"] as const;
const SEARCH_REQUEST_MODES = ["pair", "batched"] as const;
// Which Jev questions the run asked.
const SEARCH_QUESTIONS = ["both", "noul", "score"] as const;
const SEARCH_DISPLAY_SIGNALS = ["noul", "score"] as const;
// `partial`: some chunks failed.
const SEARCH_OUTCOMES = ["ok", "partial", "failed"] as const;

// Each row records the values the search actually used, because a flag change can take up to
// 30 seconds to reach every location.
export const searchRuns = sqliteTable(
  "search_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // No ON DELETE, so a user who still has search runs cannot be deleted.
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    query: text("query").notNull(),
    channel: text("channel", { enum: SEARCH_CHANNELS }).notNull(),
    inputMode: text("input_mode", { enum: SEARCH_INPUT_MODES }),
    requestMode: text("request_mode", { enum: SEARCH_REQUEST_MODES }).notNull(),
    // The model that answered. A run that got no answer, because the collection was empty or
    // every request failed, stores the configured model.
    jevModel: text("jev_model").notNull(),
    questions: text("questions", { enum: SEARCH_QUESTIONS }).notNull(),
    displaySignal: text("display_signal", { enum: SEARCH_DISPLAY_SIGNALS }).notNull(),
    noulThreshold: real("noul_threshold").notNull(),
    // On the Score's scale, 0 to 3 for its four levels.
    scoreThreshold: real("score_threshold").notNull(),
    inputTokens: integer("input_tokens"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome", { enum: SEARCH_OUTCOMES }).notNull(),
    // Set when the outcome is not `ok`.
    error: text("error"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    check("search_runs_channel", isOneOf(table.channel, SEARCH_CHANNELS)),
    check("search_runs_input_mode", isOneOf(table.inputMode, SEARCH_INPUT_MODES)),
    check("search_runs_request_mode", isOneOf(table.requestMode, SEARCH_REQUEST_MODES)),
    check("search_runs_questions", isOneOf(table.questions, SEARCH_QUESTIONS)),
    check("search_runs_display_signal", isOneOf(table.displaySignal, SEARCH_DISPLAY_SIGNALS)),
    check("search_runs_outcome", isOneOf(table.outcome, SEARCH_OUTCOMES)),
  ],
);

// Every answer for every candidate, including those below the threshold. A run that asked
// only one question has no value for the other, so its Noul column, or its three Score
// columns, are NULL, and a replay skips that signal.
export const searchAnswers = sqliteTable(
  "search_answers",
  {
    searchRunId: text("search_run_id")
      .notNull()
      .references(() => searchRuns.id, { onDelete: "cascade" }),
    // Deleting a bookmark deletes its answers and keeps the runs.
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    noul: real("noul"),
    // Jev's `score`, its `probabilities` (JSON, validated with Valibot when read) and its
    // `confidence`, which every Score answer has together.
    score: real("score"),
    scoreProbabilities: text("score_probabilities", { mode: "json" }),
    scoreConfidence: real("score_confidence"),
    shown: integer("shown", { mode: "boolean" }).notNull(),
    // A weak relevance label.
    clicked: integer("clicked", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.searchRunId, table.bookmarkId] }),
    // Deleting a bookmark finds its answers through this index, rather than reading every
    // answer in the log, which D1 bills as rows read. The primary key starts with the run, so it
    // can't serve that lookup.
    index("search_answers_bookmark_id_index").on(table.bookmarkId),
    // A Score answer always has all three, so a row has all three or none of them.
    check(
      "search_answers_score_complete",
      sql`(${table.score} IS NULL) = (${table.scoreProbabilities} IS NULL) AND (${table.score} IS NULL) = (${table.scoreConfidence} IS NULL)`,
    ),
  ],
);

// Phase 12's labeled queries. They are stored here, not in the public repository, because
// they would publish the owner's queries and saved links (#202). See "Evaluations" in the
// plan. Each query's text is stored once, and its labels refer to it by ID.
export const evalQueries = sqliteTable(
  "eval_queries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // No ON DELETE, as for bookmarks and search runs.
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    query: text("query").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  // One row per query text, so an evaluation run in `search_runs` finds its labels by its
  // user and query.
  (table) => [unique().on(table.userId, table.query)],
);

// One judgement per query and bookmark: whether the bookmark should match the query. A
// bookmark with no label for a query has not been judged for it, which is neither.
export const evalLabels = sqliteTable(
  "eval_labels",
  {
    evalQueryId: text("eval_query_id")
      .notNull()
      .references(() => evalQueries.id, { onDelete: "cascade" }),
    // Deleting a bookmark deletes its labels, as it deletes its search answers, so every label
    // names a bookmark that exists.
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    relevant: integer("relevant", { mode: "boolean" }).notNull(),
    // When the judgement was last written. Application code sets it again when it changes.
    labeledAt: integer("labeled_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.evalQueryId, table.bookmarkId] }),
    // Deleting a bookmark finds its labels through this index, as for its search answers.
    index("eval_labels_bookmark_id_index").on(table.bookmarkId),
  ],
);
