// Users are keyed on Google's stable `sub` claim, never on email, because an email can change.
// The stored email is refreshed at each sign-in, so the per-request allowlist check sees it.
import type { Db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import type { GoogleIdentity } from "./google.ts";

/** Creates the user, or updates their email, and returns their ID. */
export async function upsertUser(db: Db, identity: GoogleIdentity, now: number): Promise<string> {
  const user = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: identity.sub,
      email: identity.email,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: users.googleSub, set: { email: identity.email } })
    .returning({ id: users.id })
    .get();
  return user.id;
}
