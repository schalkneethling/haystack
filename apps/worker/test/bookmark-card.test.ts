// The parts of a bookmark's card that bookmark-card.ts renders on the Worker.
import { describe, expect, it } from "vite-plus/test";
import { savedLink } from "../src/bookmark-card.ts";

describe("savedLink", () => {
  it("links an https address without sending a referrer", () => {
    expect(savedLink("https://example.com/a?b=1&c=2", "Title").toString()).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noreferrer">Title</a>',
    );
  });

  it.each([
    "http://example.com/",
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "https:example.com",
    "/relative",
  ])("does not link %s", (url) => {
    expect(savedLink(url, "<b>Title</b>").toString()).toBe("&lt;b&gt;Title&lt;/b&gt;");
  });
});
