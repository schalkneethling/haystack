// Tables for Milestone 1. See "Data model" in plans/haystack-v1-implementation-plan.md.
// Timestamps are INTEGER epoch milliseconds, set by application code. IDs come from
// crypto.randomUUID(), also set by application code.
import { integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
    // Exactly as submitted.
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
