// Puts a link on the review page at /held, for the tests of it (#129). Only the sweep makes a
// bookmark Held or Failed, so each helper saves the link the way a user does, then sets the rows
// the sweep would have written. Each test's links need addresses of their own, because the
// Worker's database is shared by the tests of a process.
import type { Page } from "@playwright/test";
import { ENRICHMENT_SCHEMA_VERSION } from "../src/enrichment/enrichment-schema.ts";
import type { HaystackWorker } from "./fixtures.ts";
import { saveThroughForm } from "./save-through-form.ts";

type Run = HaystackWorker["run"];

/** Saves the link, then gives it the highest noul, which is at or above any threshold. */
export async function saveHeld(page: Page, run: Run, url: string, title: string): Promise<void> {
  await saveThroughForm(page, url, title);
  await run(
    "UPDATE bookmarks SET sensitivity_noul = 1, sensitivity_checked_at = ? WHERE url = ?",
    Date.now(),
    url,
  );
}

// Far above SWEEP_ATTEMPT_LIMIT in wrangler.jsonc, so the record makes the bookmark Failed.
const ATTEMPTS = 99;

/** Saves the link, then records failures at the current schema version up to Failed. */
export async function saveFailed(
  page: Page,
  run: Run,
  url: string,
  title: string,
  lastError = "llm:timeout",
): Promise<void> {
  await saveThroughForm(page, url, title);
  await run(
    "INSERT INTO enrichment_failures (bookmark_id, schema_version, attempts, consecutive_failures, last_error, last_attempt_at) SELECT id, ?, ?, ?, ?, ? FROM bookmarks WHERE url = ?",
    ENRICHMENT_SCHEMA_VERSION,
    ATTEMPTS,
    ATTEMPTS,
    lastError,
    Date.now(),
    url,
  );
}
