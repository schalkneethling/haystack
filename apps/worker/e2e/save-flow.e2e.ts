// The plan's Phase 3 acceptance: a hand-built /save link, opened while signed in and confirmed,
// creates the bookmark with the confirmed title and description, with JavaScript disabled.
import { expect, test } from "./fixtures.ts";

test.use({ javaScriptEnabled: false });

test("saving from a hand-built /save link works without JavaScript", async ({
  page,
  signIn,
  query,
}) => {
  await signIn();
  const fields = { url: "https://example.com/guide?utm_source=mail", og_title: "A guide" };
  await page.goto(`/save?${new URLSearchParams(fields).toString()}`);

  await page.getByLabel("Title").fill("My guide");
  await page.getByLabel("Description").fill("How to do the thing.");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saved");
  const rows = await query("SELECT url, title, description, og_title FROM bookmarks");
  expect(rows).toEqual([
    {
      url: "https://example.com/guide",
      title: "My guide",
      description: "How to do the thing.",
      og_title: "A guide",
    },
  ]);
});
