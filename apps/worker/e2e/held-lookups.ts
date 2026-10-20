// Holds the address form's lookups in the browser (#105, address-form.js), so a test can look at
// the processing state for as long as it needs, then decide each request's answer: let it through
// to the Worker, answer it, or fail it. The script sends the form with `fetch`, so the page stays
// where it is while a request is held, and Playwright's locators work as usual.
import type { Page, Request, Route } from "@playwright/test";

/** What address-form.js says in its status region. */
export const MESSAGES = {
  processing: "Looking up the page. This can take a few seconds.",
  timeout: "Looking up the page took too long. You can press Continue to try again.",
  network:
    "Haystack could not be reached. Check your connection, then press Continue to try again.",
  unexpected:
    "Something went wrong while looking up the page. You can press Continue to try again.",
  signedOut: "You are signed out, so the page could not be looked up. Sign in again.",
} as const;

/** Continue's label while a lookup runs. */
export const PROCESSING_LABEL = "Processing…";

export interface HeldLookup {
  /** The address the form sent. */
  readonly address: string;
  readonly request: Request;
  /** Whether the browser gave up on the request, as it does when the script aborts it. */
  aborted(): boolean;
  /** Lets the request through to the Worker. */
  release(): Promise<void>;
  /** Answers the request instead of the Worker. */
  answer(status: number, body?: unknown): Promise<void>;
  /** Fails the request, as a network error does. */
  fail(): Promise<void>;
}

export interface HeldLookups {
  /** Every lookup the page has sent since `holdLookups`, in order. */
  readonly all: readonly HeldLookup[];
  /** Waits for the next lookup, the `count`th since `holdLookups`. */
  next(count: number): Promise<HeldLookup>;
}

// A route the browser has already given up on cannot be answered, and that is not the test's
// concern, so the error is dropped.
async function settle(action: () => Promise<void>): Promise<void> {
  await action().catch(() => undefined);
}

export async function holdLookups(page: Page): Promise<HeldLookups> {
  const all: HeldLookup[] = [];
  const failed = new Set<Request>();
  page.on("requestfailed", (request) => {
    failed.add(request);
  });
  await page.route("**/save/address", (route: Route) => {
    const request = route.request();
    const address = new URLSearchParams(request.postData() ?? "").get("url") ?? "";
    all.push({
      address,
      request,
      aborted: () => failed.has(request),
      release: () => settle(() => route.continue()),
      answer: (status, body) =>
        settle(() =>
          route.fulfill(
            body === undefined
              ? { status }
              : { status, contentType: "application/json", body: JSON.stringify(body) },
          ),
        ),
      fail: () => settle(() => route.abort("failed")),
    });
  });
  return {
    all,
    next: async (count) => {
      // Up to 5 s, as long as an expectation waits.
      for (let tries = 0; all.length < count && tries < 250; tries += 1) {
        await page.waitForTimeout(20);
      }
      const lookup = all[count - 1];
      if (lookup === undefined) {
        throw new Error(`There is no lookup ${count}`);
      }
      return lookup;
    },
  };
}

/** The states the address form's script can leave the form in, for the design's tests. */
export const ADDRESS_FORM_STATES = [
  "processing",
  "a rejected address",
  "a timeout",
  "a network error",
  "signed out",
] as const;

export type AddressFormState = (typeof ADDRESS_FORM_STATES)[number];

/**
 * Puts the address form on the current page into a state, with `address` in the field. A timeout
 * needs Playwright's clock, installed before the page loaded. `lookups` holds every lookup, and
 * `count` is how many the page has sent before this one.
 */
export async function bringAddressFormTo(
  page: Page,
  lookups: HeldLookups,
  count: number,
  state: AddressFormState,
  address: string,
): Promise<void> {
  const field = page.getByRole("textbox", { name: "Save a link" });
  const status = page.locator("#save-url-status");
  // A rejected address is the server's to reject, so it goes through.
  await field.fill(state === "a rejected address" ? address.replace("https://", "") : address);
  await page.getByRole("button", { name: "Continue" }).click();
  const lookup = await lookups.next(count + 1);
  if (state === "processing") {
    await page.getByText(MESSAGES.processing).waitFor();
  } else if (state === "a rejected address") {
    await lookup.release();
    await page.getByRole("alert").waitFor();
  } else if (state === "a timeout") {
    await page.clock.fastForward(10_200);
    await status.getByText(MESSAGES.timeout).waitFor();
  } else if (state === "a network error") {
    await lookup.fail();
    await status.getByText(MESSAGES.network).waitFor();
  } else {
    await lookup.answer(401);
    await status.getByText("You are signed out").waitFor();
  }
}
