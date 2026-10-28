// The save flow. See "Save flow", "Sensitive URLs", "Probabilistic check with Jev", and "URL
// normalization" in plans/haystack-v1-implementation-plan.md. GET /save shows the confirmation
// form and never writes. The confirmation click is what stops other sites from saving into a
// user's account. Both GET and POST ask Jev whether the link looks private (save-sensitivity.ts),
// and above the threshold the form warns and asks for a checkbox before it saves (#132). A new
// bookmark is then enriched without delaying the "Saved" page (`afterSave`, #133).
import {
  CAPTURE_CAPS,
  CAPTURE_KEYS,
  type CaptureField,
  type CapturePayload,
  declaredSensitiveCanonical,
  detectSensitiveUrl,
  normalizeUrl,
  SAVE_URL_BUDGET,
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
import { BOOKMARK_TO_ENRICH_COLUMNS, type BookmarkToEnrich } from "./enrichment/enrich-bookmark.ts";
import { html, type SafeHtml } from "./html.ts";
import {
  isNotPrivateConfirmed,
  NOT_PRIVATE_LABEL,
  notPrivateCheckbox,
} from "./not-private-checkbox.ts";
import { fieldError, SENSITIVE_NOTICE } from "./notices.ts";
import { htmlResponse } from "./page.ts";
import { isInRecentSaves, RECENT_SAVES_LIMIT, type ListPosition } from "./recent-saves.ts";
import {
  checkSaveSensitivity,
  logWarningShown,
  type SaveSensitivityConfig,
  type SensitivityCheck,
} from "./save-sensitivity.ts";

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

/**
 * The captured fields from the query string, and the flag that a canonical URL was dropped
 * (#131). A repeated key uses its first value.
 */
function capturedFields(parameters: URLSearchParams): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of CAPTURE_KEYS) {
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

// The form's editable fields. A save link that returns to the form after sign-in carries them
// too, so a user whose session ended before they pressed Save gets back what they entered (#34).
const CONFIRMED_FIELDS: Record<ConfirmedField, string> = {
  title: "confirmed_title",
  description: "confirmed_description",
};

// What a save link that returns after sign-in carries instead of the entered values, when they
// would take it over SAVE_URL_BUDGET (#34).
const NOT_KEPT = { name: "confirmed_values", value: "not-kept" } as const;

/**
 * How the form came back after sign-in, from a POST /save that had no session (#34): with the
 * values the user entered, or without them, because they did not fit in the save link.
 */
type Resumed = "kept" | "not-kept";

/** A field the form can reject: the title, the description, or the unticked checkbox (#132). */
type FormField = ConfirmedField | "acknowledgment";

/** Jev's check warned that the link might be private (save-sensitivity.ts). */
interface SensitivityWarning {
  // Logged when the form shows the warning, for the calibration.
  noul: number;
  // The box was ticked, on a form that comes back for another reason.
  acknowledged: boolean;
}

interface FormState {
  title: string;
  description: string;
  // Set when a submitted value was rejected; the form is shown again with it.
  invalid?: FormField;
  resumed?: Resumed;
  // Set when the form warns and asks for the checkbox.
  warning?: SensitivityWarning;
}

// The message after the heading of a form that came back after sign-in. Pressing Save did not
// save the link, so the user needs to hear that they have to press it again. It describes the
// page, not what the user did, because a hand-built link can carry the same fields, and because
// the session can have expired rather than been signed out. Only an address that fills most of
// SAVE_URL_BUDGET leaves no room for the values.
const RESUMED_MESSAGES: Record<Resumed, string> = {
  kept: "This link is not saved yet. Check the title and description, then press Save.",
  "not-kept":
    "This link is not saved yet, and its address is too long to keep the title and description with it. Enter them again, then press Save.",
};

const FORM_ERRORS: Record<FormField, string> = {
  title: `Enter a title of up to ${CAPTURE_CAPS.title} characters.`,
  description: `Shorten the description to ${CAPTURE_CAPS.description} characters or fewer.`,
  acknowledgment: `Tick “${NOT_PRIVATE_LABEL}” to save this link.`,
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

// A form that came back after sign-in says so in its title too, because a screen reader announces
// the title when the page loads, but not a status message that arrives with it. An error's title
// comes first, because the error is what stops the save.
function formTitle(state: FormState): string {
  if (state.invalid !== undefined) {
    return "Check the form";
  }
  return state.resumed === undefined ? "Save a link" : "Not saved yet";
}

/** The warning, when the form has one, for a form state built from Jev's check. */
function warningFrom(check: SensitivityCheck, acknowledged: boolean): Pick<FormState, "warning"> {
  return check.answered && check.warns ? { warning: { noul: check.noul, acknowledged } } : {};
}

// The warning comes right after the notice about private links, because both are about the
// address, and the checkbox right after the warning, which describes it. So a screen reader reads
// the warning first, whether the user reads on or moves straight to the checkbox. A rejected box
// reads the error first, then the warning, as a rejected field reads its error.
function sensitivityCheck({ warning, invalid }: FormState): SafeHtml | null {
  if (warning === undefined) {
    return null;
  }
  const rejected = invalid === "acknowledgment";
  return html`<div class="sensitivity-check">
          <p id="sensitivity-warning" class="warning">
            <strong>This link looks as if it might be private.</strong> Haystack checked its
            address, and it looks like a link that lets in anyone who has it, such as a private
            share, an invitation, or a sign-in or download link. Save it only if it doesn't give
            access to anything private.
          </p>
          ${notPrivateCheckbox({
            id: "not-private",
            describedBy: rejected ? "save-error sensitivity-warning" : "sensitivity-warning",
            checked: warning.acknowledged,
            invalid: rejected,
          })}
        </div>`;
}

function formPage(payload: CapturePayload, url: string, state: FormState): Response {
  // Every form that shows the warning is a warning shown, whether or not a save follows.
  if (state.warning !== undefined) {
    logWarningShown(state.warning.noul);
  }
  const error =
    state.invalid === undefined ? "" : fieldError("save-error", FORM_ERRORS[state.invalid]);
  const resumed =
    state.resumed === undefined
      ? ""
      : html`<div class="status" role="status"><p>${RESUMED_MESSAGES[state.resumed]}</p></div>`;
  return htmlResponse(
    formTitle(state),
    html`<h1>Save a link</h1>${error}${resumed}
      <form class="panel" method="post" action="/save">
        <p class="address-field"><strong>Address:</strong> <span id="save-address" class="address">${url}</span></p>
        ${SENSITIVE_NOTICE}${sensitivityCheck(state)}
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

export async function existingBookmark(
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
export type Rejection =
  | { readonly invalidFields: readonly CaptureField[] }
  | { readonly sensitive: SensitiveUrlReason };

/**
 * Validates the captured fields and refuses a sensitive address. Neither check depends on who is
 * signed in, so a signed-out GET /save is screened the same way.
 */
export function screenCapture(
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
 * The page GET /save shows for a link the checks reject, whether it came from a hand-built link
 * or the extension, and the page POST /save/address shows for a rejected address (#105). A
 * rejected address gets the address form again, with the reason, so the user can correct it
 * there, and a flagged address is never put back in the field. A link whose address passes but
 * whose other fields fail gets the validation page, because the address form has no field for
 * them. Only a hand-built link can reach that page, because the extension leaves out a field that
 * fails validation, and the address form sends only the address.
 */
export function rejectedLinkPage(
  captured: Record<string, string>,
  rejection: Rejection,
  signedIn: boolean,
): Response {
  const address = rejectedAddressState(captured, rejection);
  return address === undefined
    ? invalidPage("invalidFields" in rejection ? rejection.invalidFields : [], signedIn)
    : addressFormPage(address, signedIn);
}

/**
 * What the address form shows for a rejection: the reason, and the typed value only when it may
 * go back in the field. Undefined when the address passed and other fields failed, which the
 * address form has no field for.
 */
export function rejectedAddressState(
  captured: Record<string, string>,
  rejection: Rejection,
): AddressFormState | undefined {
  if ("sensitive" in rejection) {
    return { value: "", error: SENSITIVE_URL_EXPLANATIONS[rejection.sensitive] };
  }
  if (rejection.invalidFields.includes("url")) {
    return rejectedAddress(captured.url ?? "");
  }
  return undefined;
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

// A link with no captured field, such as a bare /save, carries nothing to screen or to save. The
// flag that a canonical URL was dropped does not count: it describes a page, and without an
// address there is none, so a link that holds only the flag is a bare /save.
function hasCapturedFields(captured: Record<string, string>): boolean {
  return Object.keys(captured).some((name) => name in CAPTURE_CAPS);
}

/**
 * GET /save: without a captured field, the address form. Otherwise validate, refuse sensitive
 * URLs, drop a sensitive canonical URL, find duplicates, ask Jev whether the link looks private,
 * then show the form, with the warning and the checkbox when it does. Only a signed-in request
 * gets here, so a request that hasn't signed in spends nothing on Jev, and neither does a link
 * that is saved already.
 */
export async function showSaveForm(
  request: Request,
  db: Db,
  userId: string,
  config: SaveSensitivityConfig,
): Promise<Response> {
  const parameters = new URL(request.url).searchParams;
  const captured = capturedFields(parameters);
  if (!hasCapturedFields(captured)) {
    return addressFormPage({ value: "" }, true);
  }
  const screened = screenSaveLink(captured, true);
  if ("page" in screened) {
    return screened.page;
  }
  // A flagged canonical URL is left out of the form, so it is neither shown nor submitted. The
  // payload then carries the flag instead, which the form submits as a hidden input (#131).
  const payload = withoutSensitiveCanonicalUrl(screened.payload);
  const url = stripTrackingParameters(payload.url);
  const existing = await existingBookmark(db, userId, normalizeUrl(url));
  if (existing !== undefined) {
    return alreadySavedPage(db, userId, existing);
  }
  // The flag is evidence for Jev, as `declares_sensitive_canonical`, and the URL it is about is
  // never sent: the payload no longer has it.
  const check = await checkSaveSensitivity(
    config,
    url,
    payload.title,
    declaredSensitiveCanonical(payload),
  );
  return formPage(payload, url, {
    ...formState(parameters, prefill(payload, url)),
    ...warningFrom(check, false),
  });
}

function hasConfirmedValues(parameters: URLSearchParams): boolean {
  return Object.values(CONFIRMED_FIELDS).some((name) => parameters.has(name));
}

/**
 * What a new form shows. A save link that returns after sign-in from a POST /save without a
 * session (#34) carries the values the user entered, which are checked as POST /save checks
 * them, so the form comes back as POST /save would have shown it, or it says that they were not
 * kept, and the form starts from the prefill. A field the link does not carry starts from the
 * prefill.
 */
function formState(parameters: URLSearchParams, prefilled: FormState): FormState {
  if (hasConfirmedValues(parameters)) {
    const read = (name: string) => parameters.get(name) ?? undefined;
    return { ...confirmedValues(read, prefilled), resumed: "kept" };
  }
  if (parameters.get(NOT_KEPT.name) === NOT_KEPT.value) {
    return { ...prefilled, resumed: "not-kept" };
  }
  return prefilled;
}

/** The page to show instead of signing in, or the path and query to return to after it. */
export type SignedOutSave = { page: Response } | { returnTo: string };

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
 * The flag that a canonical URL was dropped is a payload field, so it is kept (#131).
 * The values a user entered on the form are added after them, when the link carries them, as a
 * link built for a POST /save without a session does (#34, `withConfirmedValues`).
 * A link with no captured field, such as a bare /save, returns to the bare path, which shows the
 * address form after sign-in. It holds no value at all, so it stores nothing that could be a
 * secret.
 */
export function signedOutSave(url: URL): SignedOutSave {
  const captured = capturedFields(url.searchParams);
  if (!hasCapturedFields(captured)) {
    // Every caller passes a URL whose path is /save. The literal shows that nothing from the
    // link's query or fragment is stored.
    return { returnTo: "/save" };
  }
  const screened = screenSaveLink(captured, false);
  if ("page" in screened) {
    return screened;
  }
  const query = new URLSearchParams(withoutSensitiveCanonicalUrl(screened.payload));
  return { returnTo: `${url.pathname}?${withConfirmedValues(query, url).toString()}` };
}

/**
 * The return target's query with the values the user entered on the form, from a POST /save
 * without a session (#34). They are the user's own text, and the plan stores and logs them as it
 * does the captured title and description: free text, which the sensitive URL check does not
 * apply to (plan, "Which URLs are screened"). They are normalized as POST /save normalizes them,
 * so building the target again gives the same string. The whole save link must stay within
 * SAVE_URL_BUDGET, which keeps the sign-in redirect under Cloudflare's URL limit. When the values
 * would take it over, the target says that they were not kept instead, and the form after
 * sign-in asks for them again.
 */
function withConfirmedValues(query: URLSearchParams, link: URL): URLSearchParams {
  const parameters = link.searchParams;
  if (hasConfirmedValues(parameters)) {
    const kept = new URLSearchParams(query);
    const title = parameters.get(CONFIRMED_FIELDS.title);
    if (title !== null) {
      kept.set(CONFIRMED_FIELDS.title, normalizedTitle(title));
    }
    const description = parameters.get(CONFIRMED_FIELDS.description);
    if (description !== null) {
      kept.set(CONFIRMED_FIELDS.description, normalizedDescription(description));
    }
    if (`${link.origin}${link.pathname}?${kept.toString()}`.length <= SAVE_URL_BUDGET) {
      return kept;
    }
  } else if (parameters.get(NOT_KEPT.name) !== NOT_KEPT.value) {
    return query;
  }
  const notKept = new URLSearchParams(query);
  notKept.set(NOT_KEPT.name, NOT_KEPT.value);
  return notKept;
}

/** The captured fields a form submission carries, with its line breaks as GET rendered them. */
function submittedCapture(form: FormData): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const name of CAPTURE_KEYS) {
    const value = formField(form, name);
    if (value !== undefined) {
      captured[name] = normalizeLineBreaks(value);
    }
  }
  return captured;
}

/**
 * POST /save from the form without a session (#34): the page to show instead of signing in, or
 * the save link to return to after it, as for a signed-out GET /save of the link that showed the
 * form. The hidden inputs are screened as that link would be, so a tampered submission that
 * carries a secret gets its page, and nothing is stored or sent on in a Location header. The
 * link also carries the values the user entered (`withConfirmedValues`). A body that is not a
 * form carries nothing, so it returns to the address form.
 */
export async function signedOutSubmission(request: Request): Promise<SignedOutSave> {
  const link = new URL("/save", request.url);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return signedOutSave(link);
  }
  for (const [name, value] of Object.entries(submittedCapture(form))) {
    link.searchParams.set(name, value);
  }
  for (const name of Object.values(CONFIRMED_FIELDS)) {
    const value = formField(form, name);
    if (value !== undefined) {
      link.searchParams.set(name, value);
    }
  }
  return signedOutSave(link);
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

function normalizedTitle(value: string): string {
  return collapseWhitespace(normalizeLineBreaks(value)).trim();
}

function normalizedDescription(value: string): string {
  return normalizeLineBreaks(value).trim();
}

/**
 * The confirmed title and description, trimmed, with the rejected field if any. The title is
 * required; an empty description is stored as no description. `read` gives a field's value, and
 * a field that is absent takes its value from `absent`.
 */
function confirmedValues(
  read: (name: string) => string | undefined,
  absent: Pick<FormState, ConfirmedField>,
): FormState {
  const title = normalizedTitle(read(CONFIRMED_FIELDS.title) ?? absent.title);
  const description = normalizedDescription(
    read(CONFIRMED_FIELDS.description) ?? absent.description,
  );
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
 * What POST /save does with a bookmark it has just inserted, given the row the enrichment module
 * reads. index.ts hands it to `ctx.waitUntil` with the on-save path (enrich-on-save.ts, #133), so
 * the "Saved" page doesn't wait for the enrichment.
 */
export type AfterSave = (bookmark: BookmarkToEnrich) => void;

/**
 * POST /save: validate again (hidden inputs can be tampered with), refuse sensitive URLs, drop a
 * sensitive canonical URL, strip tracking parameters, ask Jev again, and insert. The user comes
 * from the session, never from the form. A bookmark that is inserted is passed to `afterSave`
 * before the "Saved" page is returned, and a link that is saved already is not.
 *
 * The check runs again rather than trusting anything from the form, which can be tampered with.
 * Above the threshold, a submission without the checkbox gets the form again, with the warning
 * and the error, and nothing is saved. That happens to a browser that skips `required`, to a
 * request built by hand, and to a form whose GET got no answer from Jev, so it showed no box. The
 * bookmark stores the noul and when it was checked, or neither when Jev gave no answer, and the
 * acknowledgment only when this check warned and the box was ticked. So an acknowledgment always
 * means that the owner was warned and said the link isn't private, as a release on /held does: a
 * ticked box on a link Jev didn't warn about, or couldn't check, isn't stored, and the gate can
 * still hold the link later.
 */
export async function saveBookmark(
  request: Request,
  db: Db,
  userId: string,
  config: SaveSensitivityConfig,
  afterSave: AfterSave,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form submission: no form encoding, or a body that cannot be parsed.
    return notAFormPage();
  }
  const captured = submittedCapture(form);
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
  // The payload then says whether a flagged URL was dropped here or on the way to this form.
  const payload = withoutSensitiveCanonicalUrl(screened.payload);
  const url = stripTrackingParameters(payload.url);
  const confirmed = confirmedValues((name) => formField(form, name), {
    title: "",
    description: "",
  });
  const normalizedUrl = normalizeUrl(url);
  // A rejected field gets the form again, before the link is looked up, as it did before #132.
  // Otherwise a link that is saved already gets its page, so it costs no request to Jev, and its
  // form never comes back asking for a box that would change nothing. A rejected field still
  // asks Jev, because the form it comes back with shows the warning and the box, so the user
  // isn't sent back a second time for the box after correcting the field.
  if (confirmed.invalid === undefined) {
    const saved = await existingBookmark(db, userId, normalizedUrl);
    if (saved !== undefined) {
      return alreadySavedPage(db, userId, saved);
    }
  }
  // With the flag the payload says it carries, or that withoutSensitiveCanonicalUrl set just
  // now, which the bookmark stores as `sensitive_canonical_dropped` below, as on GET /save.
  const check = await checkSaveSensitivity(
    config,
    url,
    payload.title,
    declaredSensitiveCanonical(payload),
  );
  const acknowledged = check.answered && check.warns && isNotPrivateConfirmed(form);
  if (confirmed.invalid !== undefined) {
    return formPage(payload, url, { ...confirmed, ...warningFrom(check, acknowledged) });
  }
  if (check.answered && check.warns && !acknowledged) {
    return formPage(payload, url, {
      ...confirmed,
      invalid: "acknowledgment",
      ...warningFrom(check, false),
    });
  }
  const now = Date.now();
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
      // 1 when the page declared a canonical URL that was flagged: the form carried the flag, or
      // withoutSensitiveCanonicalUrl dropped one just now. 0 otherwise, so a bookmark saved after
      // this is told apart from one saved before it, which has NULL (#131).
      sensitiveCanonicalDropped: declaredSensitiveCanonical(payload),
      capturedTitle: payload.title ?? null,
      capturedDescription: payload.description ?? null,
      ogTitle: payload.og_title ?? null,
      ogDescription: payload.og_description ?? null,
      ogSiteName: payload.og_site_name ?? null,
      sensitivityNoul: check.answered ? check.noul : null,
      sensitivityCheckedAt: check.answered ? check.checkedAt : null,
      sensitivityAcknowledgedAt: acknowledged ? now : null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.normalizedUrl] })
    // The columns the enrichment module reads, as stored, so the on-save path reads no row.
    .returning(BOOKMARK_TO_ENRICH_COLUMNS)
    .get();
  if (inserted !== undefined) {
    afterSave(inserted);
    return savedPage(inserted.id);
  }
  const existing = await existingBookmark(db, userId, normalizedUrl);
  if (existing === undefined) {
    throw new Error("Insert conflicted, but no existing bookmark was found");
  }
  return alreadySavedPage(db, userId, existing);
}
