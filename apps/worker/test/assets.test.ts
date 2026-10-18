import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe("static assets", () => {
  // The list page loads this script, and the CSP allows scripts from this origin only.
  it("serves the delete dialog script as JavaScript, with nosniff and no session", async () => {
    const response = await server.fetch("/assets/delete-dialog.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("showModal");
  });

  // Every page links both stylesheets, and the CSP allows styles and fonts from this origin only.
  it.each([
    ["/assets/tokens.css", /^text\/css/, "--color-ground"],
    ["/assets/site.css", /^text\/css/, ".cards"],
  ])("serves %s as CSS, with nosniff and no session", async (path, type, content) => {
    const response = await server.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(type);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain(content);
  });

  it.each([
    "/assets/fonts/space-grotesk-latin-wght-normal.woff2",
    "/assets/fonts/jetbrains-mono-latin-wght-normal.woff2",
  ])("serves %s as a font, with nosniff", async (path) => {
    const response = await server.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Every WOFF2 file starts with the signature "wOF2".
    expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4))).toBe("wOF2");
  });

  // The Open Font License asks for the license to travel with the fonts.
  it.each(["space-grotesk", "jetbrains-mono"])("serves the %s license", async (family) => {
    const response = await server.fetch(`/assets/fonts/${family}-OFL.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("does not serve the headers file itself", async () => {
    // It falls through to the Worker, which refuses a request without a session.
    const response = await server.fetch("/_headers");
    expect(response.status).toBe(401);
  });
});
