// The save form's warning that a link might be private (#132). Above the threshold, the form
// explains why and asks for a required checkbox, and Save sends nothing until it is ticked. A
// submission without it comes back with the error, and focus is left to the browser. The form is
// plain HTML, so each test runs with and without JavaScript. The design is tested in
// design.e2e.ts.
import type { Page } from "@playwright/test";
import { expect, type HaystackWorker, test } from "./fixtures.ts";
import {
  ABOVE_THRESHOLD,
  BELOW_THRESHOLD,
  NOT_PRIVATE,
  openWarnedForm,
  saveLink,
  sendWithoutTheBox,
  UNTICKED_ERROR,
  WARNING,
} from "./sensitivity-warning.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

async function stored(query: HaystackWorker["query"], url: string) {
  return query(
    "SELECT sensitivity_noul AS noul, sensitivity_acknowledged_at AS acknowledged FROM bookmarks WHERE url = ?",
    url,
  );
}

/**
 * Checks that nothing took focus when the page loaded, so the page starts from the top, as the
 * browser leaves it. The test waits for the load event first, because the browser applies
 * `autofocus` only once the page's stylesheets have loaded.
 */
async function expectFocusNotMoved(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await expect(page.locator("body")).toBeFocused();
}

for (const javaScriptEnabled of [true, false]) {
  test.describe(javaScriptEnabled ? "with JavaScript" : "without JavaScript", () => {
    test.use({ javaScriptEnabled });
    const mode = javaScriptEnabled ? "js" : "no-js";

    test("above the threshold, the form warns, and saves once the box is ticked", async ({
      page,
      jev,
      query,
    }) => {
      const url = `https://example.com/warned-${mode}`;
      await openWarnedForm(page, jev, url);
      const checkbox = page.getByRole("checkbox", { name: NOT_PRIVATE });
      await expect(checkbox).not.toBeChecked();
      // The warning is the checkbox's description, so it is read with the box.
      await expect(checkbox).toHaveAccessibleDescription(new RegExp(`^${WARNING}`));
      await checkbox.check();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
      const [row] = await stored(query, url);
      expect(row?.noul).toBe(ABOVE_THRESHOLD);
      expect(row?.acknowledged).toEqual(expect.any(Number));
    });

    test("Save sends nothing until the box is ticked", async ({ page, jev, query }) => {
      const url = `https://example.com/unticked-${mode}`;
      await openWarnedForm(page, jev, url);
      // A click that sent the form would navigate, and Playwright waits for a navigation that a
      // click starts, so the page would have the result's title by now.
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page).toHaveTitle("Save a link - Haystack");
      // The box is the only field the browser holds the form back for.
      await expect(page.locator("input:invalid")).toHaveCount(1);
      await expect(page.locator('input[name="not_private"]:invalid')).toHaveCount(1);
      expect(await stored(query, url)).toEqual([]);
    });

    test("below the threshold, the form has neither the warning nor the box", async ({
      page,
      jev,
      query,
    }) => {
      const url = `https://example.com/not-warned-${mode}`;
      jev.noul(BELOW_THRESHOLD);
      await page.goto(saveLink(url));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Save a link");
      await expect(page.getByText(WARNING)).toHaveCount(0);
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
      expect(await stored(query, url)).toEqual([{ noul: BELOW_THRESHOLD, acknowledged: null }]);
    });

    test("a submission without the box comes back with the error, and focus is left to the browser", async ({
      page,
      jev,
      query,
    }) => {
      const url = `https://example.com/rejected-${mode}`;
      await sendWithoutTheBox(page, jev, url);
      await expect(page.getByRole("alert")).toHaveText(UNTICKED_ERROR);
      const checkbox = page.getByRole("checkbox", { name: NOT_PRIVATE });
      await expect(checkbox).toHaveAttribute("aria-invalid", "true");
      // The error first, then the warning, as a rejected field reads its error first.
      await expect(checkbox).toHaveAccessibleDescription(
        new RegExp(`^${UNTICKED_ERROR} ${WARNING}`),
      );
      await expectFocusNotMoved(page);
      expect(await stored(query, url)).toEqual([]);

      await checkbox.check();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
      const [row] = await stored(query, url);
      expect(row?.acknowledged).toEqual(expect.any(Number));
    });

    test("a Jev outage doesn't stop the save, and leaves the noul empty", async ({
      page,
      jev,
      query,
    }) => {
      const url = `https://example.com/outage-${mode}`;
      jev.unavailable();
      await page.goto(saveLink(url));
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
      expect(await stored(query, url)).toEqual([{ noul: null, acknowledged: null }]);
    });
  });
}
