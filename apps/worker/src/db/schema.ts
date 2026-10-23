// Tables for Milestones 1 and 2. See "Data model" in plans/haystack-v1-implementation-plan.md.
// Timestamps are INTEGER epoch milliseconds, set by application code. IDs come from
// crypto.randomUUID(), also set by application code.
import { integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
