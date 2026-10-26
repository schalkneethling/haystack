// OAuth state, PKCE verifier, and return target, kept server-side between sign-in and the
// callback. See "Return targets" in plans/haystack-v1-implementation-plan.md.
import { eq, lte } from "drizzle-orm";
import {
  calculatePKCECodeChallenge,
  generateRandomCodeVerifier,
  generateRandomState,
} from "oauth4webapi";
import type { Db } from "../db/client.ts";
import { authFlows } from "../db/schema.ts";
import { sha256Hex } from "./sha256.ts";

export const AUTH_FLOW_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Deletes every flow that has expired by `now`, which is when consumeAuthFlow stops accepting it,
 * and resolves to how many were deleted.
 */
export async function deleteExpiredAuthFlows(db: Db, now: number): Promise<number> {
  const result = await db.delete(authFlows).where(lte(authFlows.expiresAt, now));
  return result.meta.changes;
}

/** Stores a new flow and returns what the authorization request needs. */
export async function createAuthFlow(
  db: Db,
  returnTo: string,
  now: number,
): Promise<{ state: string; codeChallenge: string }> {
  // Anyone can start sign-in, so expired flows are removed here as well as by the scheduled
  // cleanup (scheduled.ts). That keeps the table small however often sign-in is used, even if
  // the scheduled runs stop.
  await deleteExpiredAuthFlows(db, now);
  const state = generateRandomState();
  const codeVerifier = generateRandomCodeVerifier();
  await db.insert(authFlows).values({
    stateHash: await sha256Hex(state),
    codeVerifier,
    returnTo,
    expiresAt: now + AUTH_FLOW_LIFETIME_MS,
    createdAt: now,
  });
  return { state, codeChallenge: await calculatePKCECodeChallenge(codeVerifier) };
}

/**
 * Deletes the flow for this state and returns it, or undefined when it does not exist or has
 * expired. Deleting and reading in one statement means a state can be used only once, even by
 * two concurrent callbacks.
 */
export async function consumeAuthFlow(
  db: Db,
  state: string,
  now: number,
): Promise<{ codeVerifier: string; returnTo: string } | undefined> {
  const flow = await db
    .delete(authFlows)
    .where(eq(authFlows.stateHash, await sha256Hex(state)))
    .returning({
      codeVerifier: authFlows.codeVerifier,
      returnTo: authFlows.returnTo,
      expiresAt: authFlows.expiresAt,
    })
    .get();
  if (flow === undefined || flow.expiresAt <= now) {
    return undefined;
  }
  return { codeVerifier: flow.codeVerifier, returnTo: flow.returnTo };
}
