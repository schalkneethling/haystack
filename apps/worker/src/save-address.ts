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
//
// The form works without JavaScript: the browser posts it and follows the 303. Its script
// (address-form.js) posts the same form data to this route with `fetch`, and asks for JSON with
// `Accept: application/json`, so both paths share this route and its checks. A JSON answer
// carries the save link instead of redirecting to it, and a rejected address gets the error and
// whether the typed value may stay in the field, instead of the address form's page.
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
import { ADDRESS_ERROR_TITLE } from "./address-form.ts";
import { jsonResponse, pageTitle } from "./page.ts";
import { type LookupFailure, lookUpPage } from "./page-lookup.ts";
import {
  existingBookmark,
  rejectedAddressState,
  rejectedLinkPage,
  screenCapture,
  type SignedOutSave,
  signedOutSave,
} from "./save.ts";

/** Why the save link carries the address alone, as a fixed code that is safe to log. */
type Fallback = LookupFailure | "invalid" | "no-metadata";

/** The JSON answer for a passing address: the save link to go to. */
export interface SaveLinkAnswer {
  readonly saveLink: string;
}

/** The JSON answer for a rejected address. */
export interface RejectedAddressAnswer {
  /** Why the address was rejected, as the address form's error says it. */
  readonly error: string;
  /** Whether the typed value may stay in the field. A sensitive value never may. */
  readonly keepValue: boolean;
  /** The page title the address form has with this error, as on the page the server renders. */
  readonly title: string;
}

// Only the code is logged. The address and anything from the page are never logged, because an
// address can be private and page content is untrusted.
function logFallback(reason: Fallback): void {
  console.warn("Page lookup gave no metadata:", reason);
}

// Whether the address form's script asked for JSON: a media type in `Accept` that is
// application/json, with any parameters but a quality of 0, which means "not acceptable" (RFC
// 9110, section 12.4.2).
function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((range) => {
    const [type = "", ...parameters] = range.split(";");
    if (type.trim().toLowerCase() !== "application/json") {
      return false;
    }
    const quality = parameters
      .map((parameter) => parameter.split("="))
      .find(([name]) => name?.trim().toLowerCase() === "q")?.[1];
    return quality === undefined || Number.parseFloat(quality) !== 0;
  });
}

// The save link, as a 303 to it, or as JSON for the script.
function goTo(request: Request, saveLink: string): Response {
  return wantsJson(request)
    ? jsonResponse({ saveLink } satisfies SaveLinkAnswer, 200)
    : new Response(null, { status: 303, headers: { location: saveLink } });
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

/**
 * The address form's submission without a session, from a browser without JavaScript (#34): the
 * page to show instead of signing in, or the save link to return to after it. It is the answer
 * the form shown before sign-in gets, which asks for GET /save with the address (address-form.ts),
 * so a rejected address gets the address form with its error, and nothing is stored. The user
 * returns to the save form for the address alone, because nothing is looked up before sign-in.
 */
export async function signedOutAddress(request: Request): Promise<SignedOutSave> {
  const link = new URL("/save", request.url);
  for (const [name, value] of Object.entries(await submittedFields(request))) {
    link.searchParams.set(name, value);
  }
  return signedOutSave(link);
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
 * the existing bookmark instead. Neither is one of Haystack's own addresses: Cloudflare refuses
 * a Worker's request to its own workers.dev address, and under `wrangler dev` the Worker would
 * request itself and start a sign-in. The hosts are compared, not the origins, because an address
 * on Haystack's own host is Haystack's whatever its scheme, and a request can reach the Worker as
 * http behind a proxy, as it does in the test harness. A redirect to Haystack's own address is
 * left to Cloudflare.
 */
export async function saveAddress(request: Request, db: Db, userId: string): Promise<Response> {
  const captured = await submittedFields(request);
  const screened = screenCapture(captured);
  if ("rejection" in screened) {
    // Only `url` is read from the body, so a rejection is always the address's.
    const state = rejectedAddressState(captured, screened.rejection);
    if (wantsJson(request) && state?.error !== undefined) {
      return jsonResponse(
        {
          error: state.error,
          keepValue: state.value !== "",
          title: pageTitle(ADDRESS_ERROR_TITLE),
        } satisfies RejectedAddressAnswer,
        400,
      );
    }
    return rejectedLinkPage(captured, screened.rejection, true);
  }
  const { url } = screened.payload;
  const origin = new URL(request.url).origin;
  const addressAlone = saveUrlWithinBudget(origin, { url });
  // The page is fetched without tracking parameters, as it will be saved.
  const fetchedUrl = stripTrackingParameters(url);
  if (
    new URL(fetchedUrl).host === new URL(request.url).host ||
    (await existingBookmark(db, userId, normalizeUrl(fetchedUrl))) !== undefined
  ) {
    return goTo(request, addressAlone);
  }
  const payload = await pagePayload(url, fetchedUrl, origin);
  if (typeof payload === "string") {
    logFallback(payload);
    return goTo(request, addressAlone);
  }
  return goTo(request, saveUrlWithinBudget(origin, payload));
}
