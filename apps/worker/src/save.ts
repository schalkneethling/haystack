// The save flow. See "Save flow", "Sensitive URLs", and "URL normalization" in
// plans/haystack-v1-implementation-plan.md. GET /save shows the confirmation form and never
// writes. The confirmation click is what stops other sites from saving into a user's account.
import {
  CAPTURE_CAPS,
  type CaptureField,
  type CapturePayload,
  detectSensitiveUrl,
  normalizeUrl,
  SENSITIVE_URL_EXPLANATIONS,
  type SensitiveUrlReason,
  stripTrackingParameters,
  truncate,
  validateCapturePayload,
  withoutSensitiveCanonicalUrl,
} from "@haystack/schemas";
import { and, eq } from "drizzle-orm";
import { addressFormPage, type AddressFormState } from "./address-form.ts";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { html } from "./html.ts";
import { fieldError, SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";
import { isInRecentSaves, RECENT_SAVES_LIMIT, type ListPosition } from "./recent-saves.ts";

const FIELD_LABELS: Record<CaptureField, string> = {
  url: "The address of the page",
  canonical_url: "The page's canonical address",
  title: "The page title",
  description: "The page description",
  og_title: "The page's sharing title",
  og_description: "The page's sharing description",
  og_site_name: "The site name",
};

// What a valid value looks like, shown next to each invalid field.
const TEXT_RULE = "it is too long";
const URL_RULE = `a complete https:// link, without spaces and at most ${CAPTURE_CAPS.url.toLocaleString("en")} characters long`;
const FIELD_RULES: Record<CaptureField, string> = {
  url: `Haystack saves only secure pages, so it must be ${URL_RULE}`,
  canonical_url: `it must be a complete http:// or https:// link, without spaces and at most ${CAPTURE_CAPS.canonical_url.toLocaleString("en")} characters long`,
  title: TEXT_RULE,
  description: TEXT_RULE,
  og_title: TEXT_RULE,
  og_description: TEXT_RULE,
  og_site_name: TEXT_RULE,
};

// The address form's errors for an address that fails validation. The rule is the one the
// validation page gives for the address.
const ADDRESS_ERRORS = {
  missing: "Enter the address of a page, starting with https://.",
  invalid: `Haystack saves only secure pages, so the address must be ${URL_RULE}.`,
} as const;

/** The captured fields from the query string. A repeated key uses its first value. */
function capturedFields(parameters: URLSearchParams): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of Object.keys(CAPTURE_CAPS)) {
    const value = parameters.get(name);
    if (value !== null) {
      fields[name] = value;
    }
  }
  return fields;
}

// The save pages a signed-in user reaches. The validation page and the address form are also
// shown before sign-in, so they take the signed-in state from the caller.
const SIGNED_IN = { signedIn: true } as const;

function invalidPage(invalidFields: readonly CaptureField[], signedIn: boolean): Response {
  return htmlResponse(
    "This link can't be saved",
    html`<h1>This link can't be saved</h1>
      <p>The save link has values Haystack can't use:</p>
      <ul>
        ${invalidFields.map((field) => html`<li>${FIELD_LABELS[field]}: ${FIELD_RULES[field]}</li>`)}
      </ul>`,
    400,
    { signedIn },
  );
}

// Only POST /save shows this page. GET /save shows the address form with the same reason.
function sensitivePage(reason: SensitiveUrlReason): Response {
  return htmlResponse(
    "This link can't be saved",
    html`<h1>This link can't be saved</h1>
      <p>${SENSITIVE_URL_EXPLANATIONS[reason]}</p>
      ${SENSITIVE_NOTICE}`,
    400,
    SIGNED_IN,
  );
}

async function alreadySavedPage(db: Db, userId: string, existing: ListPosition): Promise<Response> {
  // The list shows only the newest links, so an older bookmark has no anchor to link to.
  const where = (await isInRecentSaves(db, userId, existing))
    ? html`<p><a href="/#bookmark-${existing.id}">See it in your saved links</a></p>`
    : html`<p>
        It is older than the ${RECENT_SAVES_LIMIT} most recent links that
        <a href="/">your saved links</a> show.
      </p>`;
  return htmlResponse(
    "Already saved",
    html`<h1>You already saved this link</h1>
      ${where}`,
    200,
    SIGNED_IN,
  );
}

function hiddenInputs(payload: CapturePayload, url: string) {
  const raw = { ...payload, url };
  return Object.entries(raw).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  );
}

type ConfirmedField = "title" | "description";

interface FormState {
  title: string;
  description: string;
  // Set when a submitted value was rejected; the form is shown again with it.
  invalid?: ConfirmedField;
}

const CONFIRMED_ERRORS: Record<ConfirmedField, string> = {
  title: `Enter a title of up to ${CAPTURE_CAPS.title} characters.`,
  description: `Shorten the description to ${CAPTURE_CAPS.description} characters or fewer.`,
};

// The prefill for a new form. A text input drops line breaks, which would join words, so
// whitespace runs become spaces.
function prefill(payload: CapturePayload, url: string): FormState {
  const title = collapseWhitespace(payload.og_title ?? payload.title ?? url);
  return {
    // The URL can be the title fallback and is longer than the title cap.
    title: truncate(title, CAPTURE_CAPS.title),
    description: payload.og_description ?? payload.description ?? "",
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

// aria-invalid and the error's id, for the field that was rejected.
function errorAttributes(state: FormState, field: ConfirmedField) {
  return state.invalid === field ? html` aria-invalid="true" aria-describedby="save-error"` : "";
}

function formPage(payload: CapturePayload, url: string, state: FormState): Response {
  const error =
    state.invalid === undefined ? "" : fieldError("save-error", CONFIRMED_ERRORS[state.invalid]);
  return htmlResponse(
    state.invalid === undefined ? "Save a link" : "Check the form",
    html`<h1>Save a link</h1>${error}
      <form class="panel" method="post" action="/save">
        <p class="address-field"><strong>Address:</strong> <span id="save-address" class="address">${url}</span></p>
        ${SENSITIVE_NOTICE}
        <p class="field">
          <label for="confirmed-title">Title</label>
          <input
            id="confirmed-title"
            name="confirmed_title"
            type="text"
            required
            maxlength="${CAPTURE_CAPS.title}"
            value="${state.title}"${errorAttributes(state, "title")}
          >
        </p>
        <p class="field">
          <label for="confirmed-description">Description</label>
          <textarea
            id="confirmed-description"
            name="confirmed_description"
            maxlength="${CAPTURE_CAPS.description}"
            rows="4"${errorAttributes(state, "description")}
          >${state.description}</textarea>
        </p>
        ${hiddenInputs(payload, url)}
        <p>
          <button class="button button-primary" type="submit" aria-describedby="save-address sensitive-notice">Save</button>
        </p>
      </form>`,
    state.invalid === undefined ? 200 : 400,
    SIGNED_IN,
  );
}

async function existingBookmark(
  db: Db,
  userId: string,
  normalizedUrl: string,
): Promise<ListPosition | undefined> {
  return db
    .select({ id: bookmarks.id, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.normalizedUrl, normalizedUrl)))
    .get();
}

/** Why the checks reject a link: fields that fail validation, or a flagged page address. */
type Rejection =
  | { readonly invalidFields: readonly CaptureField[] }
  | { readonly sensitive: SensitiveUrlReason };

/**
 * Validates the captured fields and refuses a sensitive address. Neither check depends on who is
 * signed in, so a signed-out GET /save is screened the same way.
 */
function screenCapture(
  captured: Record<string, string>,
): { rejection: Rejection } | { payload: CapturePayload } {
  const validation = validateCapturePayload(captured);
  if (!validation.ok) {
    return { rejection: { invalidFields: validation.invalidFields } };
  }
  // On the URL as submitted, before tracking parameters are removed (plan, "Save flow").
  const reason = detectSensitiveUrl(new URL(validation.payload.url));
  if (reason !== undefined) {
    return { rejection: { sensitive: reason } };
  }
  return { payload: validation.payload };
}

// A placeholder origin for reading a typed value as a query string.
const QUERY_READING_ORIGIN = "https://haystack.invalid/?";

/**
 * The address form for an address that fails validation. `detectSensitiveUrl` runs only on a
 * valid address, so a rejected one could still carry a secret, such as `example.com/?api_key=…`
 * without a scheme. The typed value therefore goes back in the field only when it parses as a
 * URL, as typed or with `https://` added, and the sensitive URL check flags none of three
 * readings of it: as typed, with `https://` added, and as a query string, which catches
 * `access_token=…` typed on its own. A flagged value gets the refusal's reason, which the user
 * needs to hear first. A value that parses in neither way gets the rule, with an empty field,
 * because the check cannot vouch for it.
 */
function rejectedAddress(typed: string): AddressFormState {
  const trimmed = typed.trim();
  if (trimmed === "") {
    return { value: "", error: ADDRESS_ERRORS.missing };
  }
  const asUrl = [URL.parse(trimmed), URL.parse(`https://${trimmed}`)].filter(
    (url): url is URL => url !== null,
  );
  const asQuery = URL.parse(`${QUERY_READING_ORIGIN}${trimmed}`);
  for (const reading of asQuery === null ? asUrl : [...asUrl, asQuery]) {
    const reason = detectSensitiveUrl(reading);
    if (reason !== undefined) {
      return { value: "", error: SENSITIVE_URL_EXPLANATIONS[reason] };
    }
  }
  return { value: asUrl.length > 0 ? typed : "", error: ADDRESS_ERRORS.invalid };
}

/**
 * The page GET /save shows for a link the checks reject, whether it came from the address form,
 * a hand-built link or the extension. A rejected address gets the address form again, with the
 * reason, so the user can correct it there, and a flagged address is never put back in the
 * field. A link whose address passes but whose other fields fail gets the validation page,
 * because the address form has no field for them. Only a hand-built link can reach that page,
 * because the extension leaves out a field that fails validation.
 */
function rejectedLinkPage(
  captured: Record<string, string>,
  rejection: Rejection,
  signedIn: boolean,
): Response {
  if ("sensitive" in rejection) {
    return addressFormPage(
      { value: "", error: SENSITIVE_URL_EXPLANATIONS[rejection.sensitive] },
      signedIn,
    );
  }
  if (rejection.invalidFields.includes("url")) {
    return addressFormPage(rejectedAddress(captured.url ?? ""), signedIn);
  }
  return invalidPage(rejection.invalidFields, signedIn);
}

/** Screens a GET /save link. Returns the page that ends the request, or the validated payload. */
function screenSaveLink(
  captured: Record<string, string>,
  signedIn: boolean,
): { page: Response } | { payload: CapturePayload } {
  const screened = screenCapture(captured);
  return "rejection" in screened
    ? { page: rejectedLinkPage(captured, screened.rejection, signedIn) }
    : screened;
}

// A link with no captured field, such as a bare /save, carries nothing to screen or to save.
function hasCapturedFields(captured: Record<string, string>): boolean {
  return Object.keys(captured).length > 0;
}

/**
 * GET /save: without a captured field, the address form. Otherwise validate, refuse sensitive
 * URLs, drop a sensitive canonical URL, find duplicates, then show the form.
 */
export async function showSaveForm(request: Request, db: Db, userId: string): Promise<Response> {
  const captured = capturedFields(new URL(request.url).searchParams);
  if (!hasCapturedFields(captured)) {
    return addressFormPage({ value: "" }, true);
  }
  const screened = screenSaveLink(captured, true);
  if ("page" in screened) {
    return screened.page;
  }
  // A flagged canonical URL is left out of the form, so it is neither shown nor submitted.
  const payload = withoutSensitiveCanonicalUrl(screened.payload);
  const url = stripTrackingParameters(payload.url);
  const existing = await existingBookmark(db, userId, normalizeUrl(url));
  if (existing !== undefined) {
    return alreadySavedPage(db, userId, existing);
  }
  return formPage(payload, url, prefill(payload, url));
}

/**
 * GET or HEAD /save without a session: the page to show instead of signing in, or the path and
 * query to return to after it. Sign-in stores the return target in auth_flows, and a URL that
 * carries a secret is never stored (plan, decision 18), so a link that enters through /save is
 * screened before the redirect, and /auth/sign-in screens a save link it is given the same way.
 * A rejected link gets its page now, because signing in would not change it.
 *
 * The return target is built from the validated payload, without a canonical URL the form
 * leaves out, so it holds only screened values: no unknown key, no second `url`, and no empty
 * field, which validation omits. The extension builds its save URL the same way, with
 * URLSearchParams from the validated payload, so a link from the extension comes back unchanged.
 * A link with no captured field, such as a bare /save, returns to the bare path, which shows the
 * address form after sign-in. It holds no value at all, so it stores nothing that could be a
 * secret.
 */
export function signedOutSave(url: URL): { page: Response } | { returnTo: string } {
  const captured = capturedFields(url.searchParams);
  if (!hasCapturedFields(captured)) {
    // Both callers pass a URL whose path is /save. The literal shows that nothing from the
    // link's query or fragment is stored.
    return { returnTo: "/save" };
  }
  const screened = screenSaveLink(captured, false);
  if ("page" in screened) {
    return screened;
  }
  const query = new URLSearchParams(withoutSensitiveCanonicalUrl(screened.payload));
  return { returnTo: `${url.pathname}?${query.toString()}` };
}

function savedPage(bookmarkId: string): Response {
  return htmlResponse(
    "Saved",
    html`<h1>Saved</h1>
      <p><a href="/#bookmark-${bookmarkId}">See it in your saved links</a></p>`,
    200,
    SIGNED_IN,
  );
}

function formField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

// Form submission sends each line break as CRLF, while the browser's maxlength counts it as one
// character and GET rendered it as LF. Normalizing keeps submitted values as GET showed them.
function normalizeLineBreaks(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

/**
 * The confirmed title and description, trimmed, with the rejected field if any. The title is
 * required; an empty description is stored as no description.
 */
function confirmedValues(form: FormData): FormState {
  const title = collapseWhitespace(
    normalizeLineBreaks(formField(form, "confirmed_title") ?? ""),
  ).trim();
  const description = normalizeLineBreaks(formField(form, "confirmed_description") ?? "").trim();
  if (title === "" || title.length > CAPTURE_CAPS.title) {
    return { title, description, invalid: "title" };
  }
  if (description.length > CAPTURE_CAPS.description) {
    return { title, description, invalid: "description" };
  }
  return { title, description };
}

function notAFormPage(): Response {
  return htmlResponse(
    "This link can't be saved",
    html`<h1>This link can't be saved</h1>
      <p>Save links from the form on the save page.</p>`,
    400,
    SIGNED_IN,
  );
}

/**
 * POST /save: validate again (hidden inputs can be tampered with), refuse sensitive URLs, drop a
 * sensitive canonical URL, strip tracking parameters, and insert. The user comes from the
 * session, never from the form.
 */
export async function saveBookmark(request: Request, db: Db, userId: string): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form submission: no form encoding, or a body that cannot be parsed.
    return notAFormPage();
  }
  const captured: Record<string, string> = {};
  for (const name of Object.keys(CAPTURE_CAPS)) {
    const value = formField(form, name);
    if (value !== undefined) {
      captured[name] = normalizeLineBreaks(value);
    }
  }
  // The form's own hidden inputs always pass, so a rejection means a tampered or hand-built
  // submission, which gets the validation or refusal page rather than the address form.
  const screened = screenCapture(captured);
  if ("rejection" in screened) {
    const { rejection } = screened;
    return "sensitive" in rejection
      ? sensitivePage(rejection.sensitive)
      : invalidPage(rejection.invalidFields, true);
  }
  // Hidden inputs can be tampered with, so this runs again, and the bookmark is stored without it.
  const payload = withoutSensitiveCanonicalUrl(screened.payload);
  const url = stripTrackingParameters(payload.url);
  const confirmed = confirmedValues(form);
  if (confirmed.invalid !== undefined) {
    return formPage(payload, url, confirmed);
  }
  const normalizedUrl = normalizeUrl(url);
  // The unique (user_id, normalized_url) index decides duplicates, including a concurrent
  // submission that inserted first: then nothing is returned and the existing row is shown.
  const inserted = await db
    .insert(bookmarks)
    .values({
      id: crypto.randomUUID(),
      userId,
      url,
      normalizedUrl,
      title: confirmed.title,
      description: confirmed.description === "" ? null : confirmed.description,
      canonicalUrl: payload.canonical_url ?? null,
      capturedTitle: payload.title ?? null,
      capturedDescription: payload.description ?? null,
      ogTitle: payload.og_title ?? null,
      ogDescription: payload.og_description ?? null,
      ogSiteName: payload.og_site_name ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.normalizedUrl] })
    .returning({ id: bookmarks.id })
    .get();
  if (inserted !== undefined) {
    return savedPage(inserted.id);
  }
  const existing = await existingBookmark(db, userId, normalizedUrl);
  if (existing === undefined) {
    throw new Error("Insert conflicted, but no existing bookmark was found");
  }
  return alreadySavedPage(db, userId, existing);
}
