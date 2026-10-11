// Session storage in D1. See "Site sign-in" in plans/haystack-v1-implementation-plan.md.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";
import { isEmailAllowed } from "./allowlist.ts";
import { hashSessionId, SESSION_LIFETIME_MS, shouldExtendSession } from "./session-token.ts";

export interface SessionUser {
  id: string;
  email: string;
}

export interface AuthenticatedSession {
  user: SessionUser;
  expiresAt: number;
  // True when this request extended the session, so the cookie must be sent again.
  extended: boolean;
}

/**
 * Looks up the session by the hash of its ID. Deletes it and returns undefined when it has
 * expired or its user is no longer allowed. Extends it in the second half of its life.
 */
export async function authenticateSession(
  db: Db,
  sessionId: string,
  allowedEmails: ReadonlySet<string>,
  now: number,
): Promise<AuthenticatedSession | undefined> {
  const idHash = await hashSessionId(sessionId);
  const row = await db
    .select({ expiresAt: sessions.expiresAt, userId: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.idHash, idHash))
    .get();
  if (row === undefined) {
    return undefined;
  }
  if (row.expiresAt <= now || !isEmailAllowed(allowedEmails, row.email)) {
    await db.delete(sessions).where(eq(sessions.idHash, idHash));
    return undefined;
  }
  const user = { id: row.userId, email: row.email };
  if (!shouldExtendSession(row.expiresAt, now)) {
    return { user, expiresAt: row.expiresAt, extended: false };
  }
  const expiresAt = now + SESSION_LIFETIME_MS;
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.idHash, idHash));
  return { user, expiresAt, extended: true };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.idHash, await hashSessionId(sessionId)));
}
