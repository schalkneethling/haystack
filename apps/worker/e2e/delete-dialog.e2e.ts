// Deleting with JavaScript: the Delete button opens a modal dialog instead of the confirmation
// page, and the item is removed in place (plan, "Deleting bookmarks").
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { listStatus } from "./list-status.ts";
import { saveThroughForm } from "./save-through-form.ts";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

async function saveThree(page: Page, prefix: string): Promise<void> {
  for (const name of ["Oldest", "Middle", "Newest"]) {
    await saveThroughForm(page, `https://example.com/${prefix}-${name}`, `${name} ${prefix}`);
  }
  await page.goto("/");
}

test("the dialog confirms, deletes, moves focus to the next item, and announces it", async ({
  page,
  query,
}) => {
  await saveThree(page, "confirm");
  await page.getByRole("button", { name: "Delete Middle confirm" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete this link?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Middle confirm");
  await expect(dialog).toBeFocused();
  // What a screen reader announces when the dialog takes focus. VoiceOver reads the name and
  // the heading but not the description, so the name says which link is being deleted.
  await expect(dialog).toHaveAccessibleName("Delete this link? Middle confirm");
  await expect(dialog).toHaveAccessibleDescription(
    "Deleting is permanent. You can save the link again later.",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect(listStatus(page)).toHaveText("Deleted “Middle confirm”.");
  const items = page.getByRole("listitem");
  await expect(items).toHaveCount(2);
  // The next item down the list, which is the older one.
  await expect(items.nth(1).getByRole("heading", { level: 2 })).toBeFocused();
  await expect(items.nth(1)).toContainText("Oldest confirm");
  // No page load: the list stayed on /.
  expect(new URL(page.url()).pathname).toBe("/");
  const rows = await query(
    "SELECT title FROM bookmarks WHERE url LIKE ? ORDER BY title",
    "https://example.com/confirm-%",
  );
  expect(rows).toEqual([{ title: "Newest confirm" }, { title: "Oldest confirm" }]);
});

test("deleting the last item in the list moves focus to the item before it", async ({ page }) => {
  await saveThree(page, "last");
  await page.getByRole("button", { name: "Delete Oldest last" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("listitem").last().getByRole("heading")).toBeFocused();
  await expect(page.getByRole("listitem").last()).toContainText("Middle last");
});

test("deleting the only item moves focus to the heading and shows the empty state", async ({
  page,
}) => {
  await saveThroughForm(page, "https://example.com/only", "Only guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete Only guide" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Saved links" })).toBeFocused();
  await expect(page.getByText("You haven't saved any links yet.")).toBeVisible();
  await expect(page.getByRole("list")).toHaveCount(0);
});

test("a second Enter after opening the dialog deletes nothing, and Tab reaches Cancel first", async ({
  page,
  query,
}) => {
  await saveThroughForm(page, "https://example.com/keyboard", "Keyboard guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete Keyboard guide" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete this link?" });
  await expect(dialog).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  // No delete started: one would mark the buttons busy and announce a result.
  await expect(dialog.getByRole("button", { name: "Delete" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(listStatus(page)).toBeEmpty();
  expect(
    await query("SELECT id FROM bookmarks WHERE url = ?", "https://example.com/keyboard"),
  ).toHaveLength(1);

  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
});

test("reopening the dialog for another item names that item", async ({ page }) => {
  await saveThree(page, "reopen");
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Delete Newest reopen" }).click();
  await expect(dialog).toHaveAccessibleName("Delete this link? Newest reopen");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete Oldest reopen" }).click();
  await expect(dialog).toHaveAccessibleName("Delete this link? Oldest reopen");
});

for (const [how, close] of [
  ["Escape", (page: Page) => page.keyboard.press("Escape")],
  [
    "Cancel",
    (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(),
  ],
] as const) {
  test(`${how} closes the dialog, deletes nothing, and returns focus to the button`, async ({
    page,
    query,
  }) => {
    await saveThroughForm(page, `https://example.com/kept-${how}`, `Kept ${how}`);
    await page.goto("/");
    const button = page.getByRole("button", { name: `Delete Kept ${how}` });
    await button.click();
    await close(page);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(button).toBeFocused();
    const rows = await query(
      "SELECT id FROM bookmarks WHERE url = ?",
      `https://example.com/kept-${how}`,
    );
    expect(rows).toHaveLength(1);
  });
}

interface Announcement {
  text: string;
  dialogOpen: boolean;
  focusedTag: string;
  focusedItem: string;
  /** Milliseconds from the call to `dialog.close()` to the write, or NaN if it was not called. */
  msSinceClose: number;
}

/**
 * Records the page state at the moment the status message is written: whether the dialog is
 * still open, what has focus, and how long ago the dialog was closed. The write is
 * caught synchronously, because a MutationObserver reports after the whole task, when the
 * dialog has closed and focus has moved whatever the order was. This relies on the script
 * writing the message with `replaceChildren`.
 */
async function recordAnnouncements(page: Page): Promise<Announcement[]> {
  const announcements: Announcement[] = [];
  await page.exposeFunction("recordAnnouncement", (announcement: Announcement) => {
    announcements.push(announcement);
  });
  await page.evaluate(() => {
    const status = document.getElementById("list-status");
    const dialog = document.querySelector("dialog");
    if (status === null || dialog === null) {
      throw new Error("The page has no status region or dialog.");
    }
    let closedAt = Number.NaN;
    // Not the `close` event: it is dispatched in a later task, which can come tens of
    // milliseconds after the script has started its timer.
    const close = dialog.close.bind(dialog);
    dialog.close = (...args) => {
      closedAt = performance.now();
      close(...args);
    };
    const write = status.replaceChildren.bind(status);
    status.replaceChildren = (...nodes) => {
      const msSinceClose = performance.now() - closedAt;
      const focused = document.activeElement;
      (
        window as unknown as { recordAnnouncement(announcement: Announcement): void }
      ).recordAnnouncement({
        text: nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join(""),
        dialogOpen: dialog.open,
        focusedTag: focused?.localName ?? "",
        focusedItem: focused?.closest("li")?.querySelector("h2")?.textContent?.trim() ?? "",
        msSinceClose,
      });
      write(...nodes);
    };
  });
  return announcements;
}

/**
 * The script waits 100 ms before it writes the message, because VoiceOver does not speak one
 * that is written in the same task as the dialog closing (plan, "Deleting bookmarks"). A timer
 * never fires early, so 90 ms only leaves room for the clock being coarse.
 */
function expectDelayed(announcement: Announcement | undefined): void {
  expect(announcement?.msSinceClose).toBeGreaterThanOrEqual(90);
}

// The message has to come after the dialog is closed and focus has moved, and after that delay.
test("the status message is written after the dialog closes and focus moves to the next item", async ({
  page,
}) => {
  await saveThree(page, "order");
  const announcements = await recordAnnouncements(page);
  await page.getByRole("button", { name: "Delete Middle order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(listStatus(page)).toHaveText("Deleted “Middle order”.");

  expect(announcements).toHaveLength(1);
  expect(announcements[0]).toMatchObject({
    dialogOpen: false,
    focusedTag: "h2",
    focusedItem: "Oldest order",
  });
  expectDelayed(announcements[0]);
});

test("after a failed delete, the status message is written once focus is back on the Delete button", async ({
  page,
}) => {
  await saveThree(page, "failed");
  await page.route("**/bookmarks/*/delete", (route) => route.fulfill({ status: 500 }));
  const announcements = await recordAnnouncements(page);
  await page.getByRole("button", { name: "Delete Middle failed" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(listStatus(page)).toHaveText(
    "Could not delete “Middle failed”. Reload the page and try again.",
  );

  expect(announcements).toHaveLength(1);
  expect(announcements[0]).toMatchObject({
    dialogOpen: false,
    focusedTag: "button",
    focusedItem: "Middle failed",
  });
  expectDelayed(announcements[0]);
});

test("a bookmark already deleted elsewhere is removed and announced", async ({ page, query }) => {
  await saveThroughForm(page, "https://example.com/elsewhere", "Elsewhere guide");
  await page.goto("/");
  await page.getByRole("button", { name: "Delete Elsewhere guide" }).click();
  // Another tab deletes it while the dialog is open.
  const [row] = await query(
    "SELECT id FROM bookmarks WHERE url = ?",
    "https://example.com/elsewhere",
  );
  await page.request.post(`/bookmarks/${String(row?.id)}/delete`, {
    form: { confirm: "yes" },
    headers: { origin: new URL(page.url()).origin },
  });
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(listStatus(page)).toHaveText("“Elsewhere guide” was already deleted.");
  await expect(page.getByRole("button", { name: "Delete Elsewhere guide" })).toHaveCount(0);
});

test("the dialog cannot be closed while the delete request runs", async ({ page, query }) => {
  await saveThroughForm(page, "https://example.com/in-flight", "In-flight guide");
  await page.goto("/");
  // Hold the delete request until the test lets it go. Routing is local; nothing leaves the
  // machine.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/bookmarks/*/delete", async (route) => {
    await held;
    await route.continue();
  });

  await page.getByRole("button", { name: "Delete In-flight guide" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.keyboard.press("Escape");
  // Playwright waits for an aria-disabled button to be enabled, so send the click directly.
  await dialog.getByRole("button", { name: "Cancel" }).dispatchEvent("click");
  await expect(dialog).toBeVisible();

  release();
  await expect(dialog).toBeHidden();
  await expect(listStatus(page)).toHaveText("Deleted “In-flight guide”.");
  const rows = await query(
    "SELECT id FROM bookmarks WHERE url = ?",
    "https://example.com/in-flight",
  );
  expect(rows).toHaveLength(0);
});

test("a delete after the session ended keeps the item and says why", async ({ page, signOut }) => {
  await saveThroughForm(page, "https://example.com/signed-out", "Signed-out guide");
  await page.goto("/");
  const button = page.getByRole("button", { name: "Delete Signed-out guide" });
  await button.click();
  // Ends the session in the browser, as an ended session would.
  await signOut();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(listStatus(page)).toHaveText(
    "Could not delete “Signed-out guide”, because you are signed out. Reload the page to sign in again.",
  );
  await expect(button).toBeVisible();
  await expect(button).toBeFocused();
});
