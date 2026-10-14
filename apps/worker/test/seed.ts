// Seeds users, sessions, and bookmarks in a harness D1, for tests of signed-in routes.
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
  createdAt?: number;
}

export async function seedBookmark(
  db: D1Like,
  userId: string,
  url: string,
  normalizedUrl: string,
  { title = "Seeded", description, createdAt = Date.now() }: SeededBookmarkFields = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO bookmarks (id, user_id, url, normalized_url, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, userId, url, normalizedUrl, title, description ?? null, createdAt)
    .run();
  return id;
}
