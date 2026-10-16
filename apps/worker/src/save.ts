// The save flow. See "Save flow", "Sensitive URLs", and "URL normalization" in
// plans/haystack-v1-implementation-plan.md. GET /save shows the confirmation form and never
// writes. The confirmation click is what stops other sites from saving into a user's account.
import {
  CAPTURE_CAPS,
  type CaptureField,
  type CapturePayload,
  detectSensitiveUrl,
  normalizeUrl,
  type SensitiveUrlReason,
  stripTrackingParameters,
  validateCapturePayload,
} from "@haystack/schemas";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { bookmarks } from "./db/schema.ts";
import { html } from "./html.ts";
import { SENSITIVE_NOTICE } from "./notices.ts";
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
const FIELD_RULES: Record<CaptureField, string> = {
  url: `Haystack saves only secure pages, so it must be a complete https:// link, without spaces and at most ${CAPTURE_CAPS.url.toLocaleString("en")} characters long`,
  canonical_url: `it must be a complete http:// or https:// link, without spaces and at most ${CAPTURE_CAPS.canonical_url.toLocaleString("en")} characters long`,
  title: TEXT_RULE,
  description: TEXT_RULE,
  og_title: TEXT_RULE,
  og_description: TEXT_RULE,
  og_site_name: TEXT_RULE,
};

// One explanation per reason. The URL itself is never shown, because it may be the secret.
const SENSITIVE_REASONS: Record<SensitiveUrlReason, string> = {
  "embedded-credentials":
    "This link contains a user name or password, so anyone who has it could sign in with them.",
  "signed-storage-url":
    "This link contains a signed access key, so it could let anyone who has it download the file.",
  "credential-parameter":
    "This link contains an access token, key, or password, so it could let anyone who has it act as you.",
};

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

function invalidPage(invalidFields: readonly CaptureField[]): Response {
  return htmlResponse(
    "This link can't be saved",
    html`<h1>This link can't be saved</h1>
      <p>The save link has values Haystack can't use:</p>
      <ul>
        ${invalidFields.map((field) => html`<li>${FIELD_LABELS[field]}: ${FIELD_RULES[field]}</li>`)}
      </ul>`,
    400,
  );
}

function sensitivePage(reason: SensitiveUrlReason): Response {
  return htmlResponse(
    "This link can't be saved",
    html`<h1>This link can't be saved</h1>
      <p>${SENSITIVE_REASONS[reason]}</p>
      ${SENSITIVE_NOTICE}`,
    400,
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
  );
}

function hiddenInputs(payload: CapturePayload, url: string) {
  const raw = { ...payload, url };
  return Object.entries(raw).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  );
}

// The URL can be the title fallback and is longer than the title cap. Cut by UTF-16 code units,
// as the caps count, without splitting a surrogate pair.
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const end = /[\ud800-\udbff]/.test(value.charAt(maxLength - 1)) ? maxLength - 1 : maxLength;
  return value.slice(0, end);
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
  // The alert is on a wrapper, and the field's aria-describedby points at the plain paragraph
  // inside it. VoiceOver in WebKit does not read a description from an element that has a
  // live-region role itself. See "Save flow" in plans/haystack-v1-implementation-plan.md.
  const error =
    state.invalid === undefined
      ? ""
      : html`<div role="alert"><p id="save-error">${CONFIRMED_ERRORS[state.invalid]}</p></div>`;
  return htmlResponse(
    state.invalid === undefined ? "Save a link" : "Check the form",
    html`<h1>Save a link</h1>${error}
      <form method="post" action="/save">
        <p><strong>Address:</strong> <span id="save-address">${url}</span></p>
        ${SENSITIVE_NOTICE}
        <p>
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
        <p>
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
          <button type="submit" aria-describedby="save-address sensitive-notice">Save</button>
        </p>
      </form>`,
    state.invalid === undefined ? 200 : 400,
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

/** GET /save: validate, refuse sensitive URLs, find duplicates, then show the form. */
export async function showSaveForm(request: Request, db: Db, userId: string): Promise<Response> {
  const validation = validateCapturePayload(capturedFields(new URL(request.url).searchParams));
  if (!validation.ok) {
    return invalidPage(validation.invalidFields);
  }
  const { payload } = validation;
  // On the URL as submitted, before tracking parameters are removed (plan, "Save flow").
  const reason = detectSensitiveUrl(new URL(payload.url));
  if (reason !== undefined) {
    return sensitivePage(reason);
  }
  const url = stripTrackingParameters(payload.url);
  const existing = await existingBookmark(db, userId, normalizeUrl(url));
  if (existing !== undefined) {
    return alreadySavedPage(db, userId, existing);
  }
  return formPage(payload, url, prefill(payload, url));
}

function savedPage(bookmarkId: string): Response {
  return htmlResponse(
    "Saved",
    html`<h1>Saved</h1>
      <p><a href="/#bookmark-${bookmarkId}">See it in your saved links</a></p>`,
    200,
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
  );
}

/**
 * POST /save: validate again (hidden inputs can be tampered with), refuse sensitive URLs, strip
 * tracking parameters, and insert. The user comes from the session, never from the form.
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
  const validation = validateCapturePayload(captured);
  if (!validation.ok) {
    return invalidPage(validation.invalidFields);
  }
  const { payload } = validation;
  const reason = detectSensitiveUrl(new URL(payload.url));
  if (reason !== undefined) {
    return sensitivePage(reason);
  }
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
