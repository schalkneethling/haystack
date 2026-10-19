// POST /save/address: the address form's Continue (#105). It screens the address as GET /save
// does, reads the page's title and description, and sends the browser on to the save form with
// them, through a 303 to the same save link the extension opens. See "Save flow" in
// plans/haystack-v1-implementation-plan.md.
//
// It is a POST because fetching a page can have side effects: some links act when they are
// opened, such as magic sign-in links and confirm or unsubscribe links. A GET must be safe to
// request without asking, and browsers, link previews and prefetching request GETs on their own,
// so the fetch runs only after the user's explicit action. The redirect keeps the save form an
// ordinary GET page, so reloading it or going back to it never fetches again, and GET /save
// itself never fetches.
import {
  type CapturePayload,
  capturedFieldsFromPage,
  normalizeUrl,
  saveUrlWithinBudget,
  stripTrackingParameters,
  validateCapturePayload,
  withoutSensitiveCanonicalUrl,
} from "@haystack/schemas";
import type { Db } from "./db/client.ts";
import { type LookupFailure, lookUpPage } from "./page-lookup.ts";
import { existingBookmark, rejectedLinkPage, screenCapture } from "./save.ts";

/** Why the save link carries the address alone, as a fixed code that is safe to log. */
type Fallback = LookupFailure | "invalid" | "no-metadata";

// Only the code is logged. The address and anything from the page are never logged, because an
// address can be private and page content is untrusted.
function logFallback(reason: Fallback): void {
  console.warn("Page lookup gave no metadata:", reason);
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// The submitted address, or nothing when the body has no `url` or is not a form.
async function submittedFields(request: Request): Promise<Record<string, string>> {
  try {
    const value = (await request.formData()).get("url");
    return typeof value === "string" ? { url: value } : {};
  } catch {
    return {};
  }
}

// The payload the page's metadata gives, or why there is none. Every value is untrusted page
// content: it is cut to its cap and validated like the extension's, and a canonical URL that
// carries a secret is dropped, as GET /save drops it. A value that fails validation leaves the
// address alone, so the save form looks as it does without a lookup.
async function pagePayload(
  url: string,
  fetchedUrl: string,
  origin: string,
): Promise<CapturePayload | Fallback> {
  const lookup = await lookUpPage(fetchedUrl, origin);
  if (!lookup.ok) {
    return lookup.reason;
  }
  const validation = validateCapturePayload(capturedFieldsFromPage(url, lookup.metadata));
  if (!validation.ok) {
    return "invalid";
  }
  const payload = withoutSensitiveCanonicalUrl(validation.payload);
  return Object.keys(payload).length > 1 ? payload : "no-metadata";
}

/**
 * The address form's submission. A rejected address gets the address form again, with its
 * reason, and nothing is fetched. A passing address is looked up, and the browser is sent to the
 * save form with what the page says about itself, or with the address alone when the lookup
 * gives nothing. An address that is already saved is not looked up, because the save form shows
 * the existing bookmark instead.
 */
export async function saveAddress(request: Request, db: Db, userId: string): Promise<Response> {
  const captured = await submittedFields(request);
  const screened = screenCapture(captured);
  if ("rejection" in screened) {
    return rejectedLinkPage(captured, screened.rejection, true);
  }
  const { url } = screened.payload;
  const origin = new URL(request.url).origin;
  const addressAlone = saveUrlWithinBudget(origin, { url });
  // The page is fetched without tracking parameters, as it will be saved.
  const fetchedUrl = stripTrackingParameters(url);
  if ((await existingBookmark(db, userId, normalizeUrl(fetchedUrl))) !== undefined) {
    return seeOther(addressAlone);
  }
  const payload = await pagePayload(url, fetchedUrl, origin);
  if (typeof payload === "string") {
    logFallback(payload);
    return seeOther(addressAlone);
  }
  return seeOther(saveUrlWithinBudget(origin, payload));
}
