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
import { htmlResponse } from "./page.ts";

const FIELD_LABELS: Record<CaptureField, string> = {
  url: "The address of the page",
  canonical_url: "The page's canonical address",
  title: "The page title",
  description: "The page description",
  og_title: "The page's sharing title",
  og_description: "The page's sharing description",
  og_site_name: "The site name",
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

const SENSITIVE_NOTICE = html`<p id="sensitive-notice">
  Do not save links that contain access tokens, private shares, or sign-in and password reset
  links. Saved links are sent to the services that describe them, so a private link would no
  longer be private.
</p>`;

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
        ${invalidFields.map((field) => html`<li>${FIELD_LABELS[field]}</li>`)}
      </ul>
      <p>
        Addresses must be complete http:// or https:// links without spaces, and text fields have
        length limits.
      </p>`,
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

function alreadySavedPage(bookmarkId: string): Response {
  return htmlResponse(
    "Already saved",
    html`<h1>You already saved this link</h1>
      <p><a href="/#bookmark-${bookmarkId}">See it in your saved links</a></p>`,
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

function formPage(payload: CapturePayload, url: string): Response {
  // A text input drops line breaks, which would join words, so whitespace runs become spaces.
  const title = (payload.og_title ?? payload.title ?? url).replace(/\s+/g, " ");
  const description = payload.og_description ?? payload.description ?? "";
  return htmlResponse(
    "Save a link",
    html`<h1>Save a link</h1>
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
            value="${truncate(title, CAPTURE_CAPS.title)}"
          >
        </p>
        <p>
          <label for="confirmed-description">Description</label>
          <textarea
            id="confirmed-description"
            name="confirmed_description"
            maxlength="${CAPTURE_CAPS.description}"
            rows="4"
          >${description}</textarea>
        </p>
        ${hiddenInputs(payload, url)}
        <p>
          <button type="submit" aria-describedby="save-address sensitive-notice">Save</button>
        </p>
      </form>`,
    200,
  );
}

async function existingBookmarkId(
  db: Db,
  userId: string,
  normalizedUrl: string,
): Promise<string | undefined> {
  const row = await db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.normalizedUrl, normalizedUrl)))
    .get();
  return row?.id;
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
  const existingId = await existingBookmarkId(db, userId, normalizeUrl(url));
  if (existingId !== undefined) {
    return alreadySavedPage(existingId);
  }
  return formPage(payload, url);
}

function invalidConfirmationPage(): Response {
  return htmlResponse(
    "Check the title",
    html`<h1>Check the title and description</h1>
      <p>
        The title is required and can be up to ${CAPTURE_CAPS.title} characters. The description
        can be up to ${CAPTURE_CAPS.description} characters.
      </p>
      <p>Go back to the form to correct them.</p>`,
    400,
  );
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

/**
 * The confirmed title and description, trimmed. The title is required; an empty description is
 * stored as no description. Lengths use the same caps as the captured values.
 */
function confirmedValues(
  form: FormData,
): { title: string; description: string | null } | undefined {
  const title = (formField(form, "confirmed_title") ?? "").trim();
  const description = (formField(form, "confirmed_description") ?? "").trim();
  if (
    title === "" ||
    title.length > CAPTURE_CAPS.title ||
    description.length > CAPTURE_CAPS.description
  ) {
    return undefined;
  }
  return { title, description: description === "" ? null : description };
}

/**
 * POST /save: validate again (hidden inputs can be tampered with), refuse sensitive URLs, strip
 * tracking parameters, and insert. The user comes from the session, never from the form.
 */
export async function saveBookmark(request: Request, db: Db, userId: string): Promise<Response> {
  const form = await request.formData();
  const captured: Record<string, string> = {};
  for (const name of Object.keys(CAPTURE_CAPS)) {
    const value = formField(form, name);
    if (value !== undefined) {
      captured[name] = value;
    }
  }
  const validation = validateCapturePayload(captured);
  if (!validation.ok) {
    return invalidPage(validation.invalidFields);
  }
  const confirmed = confirmedValues(form);
  if (confirmed === undefined) {
    return invalidConfirmationPage();
  }
  const { payload } = validation;
  const reason = detectSensitiveUrl(new URL(payload.url));
  if (reason !== undefined) {
    return sensitivePage(reason);
  }
  const url = stripTrackingParameters(payload.url);
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
      description: confirmed.description,
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
  const existingId = await existingBookmarkId(db, userId, normalizedUrl);
  if (existingId === undefined) {
    throw new Error("Insert conflicted, but no existing bookmark was found");
  }
  return alreadySavedPage(existingId);
}
