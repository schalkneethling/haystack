// Seeds users, sessions, bookmarks, and their enrichment rows in a harness D1, for tests that
// need them.
import {
  generateSessionId,
  hashSessionId,
  SESSION_LIFETIME_MS,
} from "../src/auth/session-token.ts";

// The harness types its D1 binding as `any`; this is the part the helpers use.
interface D1Like {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export interface SeededUser {
  userId: string;
  // A Cookie header that signs this user in.
  cookie: string;
}

export async function seedSignedInUser(db: D1Like, email: string): Promise<SeededUser> {
  const userId = crypto.randomUUID();
  const sessionId = generateSessionId();
  const now = Date.now();
  await db
    .prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `sub-${userId}`, email, now)
    .run();
  await db
    .prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await hashSessionId(sessionId), userId, now + SESSION_LIFETIME_MS - 1000, now)
    .run();
  return { userId, cookie: `__Host-session=${sessionId}` };
}

export interface SeededBookmarkFields {
  title?: string;
  description?: string;
  // What the page said about itself, which the save form keeps as enrichment evidence.
  canonicalUrl?: string;
  capturedTitle?: string;
  capturedDescription?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogSiteName?: string;
  sensitiveCanonicalDropped?: boolean;
  sensitivityNoul?: number;
  sensitivityCheckedAt?: number;
  sensitivityAcknowledgedAt?: number;
  createdAt?: number;
}

export async function seedBookmark(
  db: D1Like,
  userId: string,
  url: string,
  normalizedUrl: string,
  {
    title = "Seeded",
    description,
    canonicalUrl,
    capturedTitle,
    capturedDescription,
    ogTitle,
    ogDescription,
    ogSiteName,
    sensitiveCanonicalDropped,
    sensitivityNoul,
    sensitivityCheckedAt,
    sensitivityAcknowledgedAt,
    createdAt = Date.now(),
  }: SeededBookmarkFields = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, description, canonical_url, captured_title, captured_description, og_title, og_description, og_site_name, sensitive_canonical_dropped, sensitivity_noul, sensitivity_checked_at, sensitivity_acknowledged_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      userId,
      url,
      normalizedUrl,
      title,
      description ?? null,
      canonicalUrl ?? null,
      capturedTitle ?? null,
      capturedDescription ?? null,
      ogTitle ?? null,
      ogDescription ?? null,
      ogSiteName ?? null,
      // The column is an integer that Drizzle reads as a boolean.
      sensitiveCanonicalDropped === undefined ? null : Number(sensitiveCanonicalDropped),
      sensitivityNoul ?? null,
      sensitivityCheckedAt ?? null,
      sensitivityAcknowledgedAt ?? null,
      createdAt,
    )
    .run();
  return id;
}

export interface SeededEnrichmentFields {
  kind?: string;
  // Stored as JSON, as the `data` column holds it.
  data?: unknown;
  matchText?: string;
  matchTextVersion?: number;
  createdAt?: number;
}

/** An enrichment of the bookmark at `schemaVersion`, with placeholder content unless given. */
export async function seedEnrichment(
  db: D1Like,
  bookmarkId: string,
  schemaVersion: number,
  {
    kind = "article",
    data = {},
    matchText = "Seeded",
    matchTextVersion = 1,
    createdAt = Date.now(),
  }: SeededEnrichmentFields = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO enrichments (id, bookmark_id, schema_version, provider, model, kind, kind_probabilities, data, match_text, match_text_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      bookmarkId,
      schemaVersion,
      "seed",
      "seed",
      kind,
      "{}",
      JSON.stringify(data),
      matchText,
      matchTextVersion,
      createdAt,
    )
    .run();
  return id;
}

/**
 * A failure record for the bookmark at `schemaVersion`, with `attempts` permanent failures, and
 * `consecutiveFailures` in all, which are the permanent ones unless a test says otherwise. The
 * last attempt is now, and the last error is a placeholder that isn't in `last_error`'s format,
 * unless a test says otherwise.
 */
export async function seedEnrichmentFailure(
  db: D1Like,
  bookmarkId: string,
  schemaVersion: number,
  attempts: number,
  consecutiveFailures = attempts,
  lastAttemptAt = Date.now(),
  lastError = "Seeded failure",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO enrichment_failures (bookmark_id, schema_version, attempts, consecutive_failures, last_error, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(bookmarkId, schemaVersion, attempts, consecutiveFailures, lastError, lastAttemptAt)
    .run();
}

export interface BulkBookmark {
  url: string;
  normalizedUrl: string;
  createdAt: number;
}

/**
 * Seeds many bookmarks, titled "Seeded", in one statement and returns their ids in order. A
 * harness D1 call blocks the test's thread on a round trip through Miniflare's proxy, and
 * `seedBookmark` makes several per row, so seeding fifty rows with it takes about a second, and
 * under load can run past a test's timeout (#161). The rows travel as one JSON parameter, which
 * `json_each` unpacks into a row each.
 */
export async function seedBookmarks(
  db: D1Like,
  userId: string,
  bookmarks: BulkBookmark[],
): Promise<string[]> {
  const rows = bookmarks.map((bookmark) => ({ id: crypto.randomUUID(), ...bookmark }));
  await db
    .prepare(
      "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, created_at) SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.url'), json_extract(value, '$.normalizedUrl'), 'Seeded', json_extract(value, '$.createdAt') FROM json_each(?2)",
    )
    .bind(userId, JSON.stringify(rows))
    .run();
  return rows.map((row) => row.id);
}
