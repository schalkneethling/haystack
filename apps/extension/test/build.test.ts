import { mkdtempDisposable, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { buildExtension, parseHaystackOrigin } from "../build.ts";
import { BROWSERS, manifestFor } from "../manifest.ts";

const ORIGIN = "https://haystack.example";

describe("parseHaystackOrigin", () => {
  for (const [value, origin] of [
    ["https://haystack.example", "https://haystack.example"],
    ["https://haystack.example/", "https://haystack.example"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://[::1]:5173", "http://[::1]:5173"],
  ] as const) {
    it(`accepts ${value}`, () => {
      expect(parseHaystackOrigin(value)).toBe(origin);
    });
  }

  for (const [name, value, message] of [
    ["unset", undefined, "HAYSTACK_ORIGIN is not set"],
    ["empty", " ", "HAYSTACK_ORIGIN is not set"],
    ["not a URL", "haystack.example", "is not a URL"],
    ["http on a host that isn't loopback", "http://haystack.example", "must use https:"],
    ["another scheme", "ftp://haystack.example", "must use https:"],
    ["with a path", "https://haystack.example/app", "must be an origin only"],
    ["with a query", "https://haystack.example/?a=1", "must be an origin only"],
    ["with a user name", "https://me@haystack.example", "must be an origin only"],
  ] as const) {
    it(`refuses an origin that is ${name}`, () => {
      expect(() => parseHaystackOrigin(value)).toThrow(message);
    });
  }
});

describe("manifestFor", () => {
  for (const version of ["0", "0.0.0", "1.0.0-beta.1", "01.0", "1.2.3.4.5", "70000"]) {
    for (const browser of BROWSERS) {
      it(`refuses the version ${version}, which ${browser} would not load`, () => {
        expect(() => manifestFor(browser, version)).toThrow("must be one to four");
      });
    }
  }

  // A key in one browser's manifest and not the other's must be one that only that browser
  // reads, so the two builds can't drift apart in what they ask of the user.
  it("gives Chrome and Firefox the same manifest apart from their browser-specific keys", () => {
    const { minimum_chrome_version, ...chrome } = manifestFor("chrome", "1.2.3") as Record<
      string,
      unknown
    >;
    const { browser_specific_settings, ...firefox } = manifestFor("firefox", "1.2.3") as Record<
      string,
      unknown
    >;

    expect(minimum_chrome_version).toBeDefined();
    expect(browser_specific_settings).toBeDefined();
    expect(firefox).toEqual(chrome);
  });

  it("keeps each browser's own keys out of the other's manifest", () => {
    expect(manifestFor("chrome", "1.2.3")).not.toHaveProperty("browser_specific_settings");
    expect(manifestFor("firefox", "1.2.3")).not.toHaveProperty("minimum_chrome_version");
  });

  it("gives Firefox a permanent add-on ID that doesn't carry the product's name", () => {
    expect(manifestFor("firefox", "1.2.3")).toMatchObject({
      browser_specific_settings: { gecko: { id: "bookmarks@schalkneethling.com" } },
    });
  });

  // The popup sends the page's address, title and description to Haystack's own server.
  it("declares the data the popup sends to Haystack", () => {
    expect(manifestFor("firefox", "1.2.3")).toMatchObject({
      browser_specific_settings: {
        gecko: {
          data_collection_permissions: { required: ["browsingActivity", "websiteContent"] },
        },
      },
    });
  });

  // Firefox shows its built-in data consent from 140 on desktop.
  it("keeps Firefox from installing the add-on where it can't show the data consent", () => {
    const { gecko } = (
      manifestFor("firefox", "1.2.3") as unknown as {
        browser_specific_settings: { gecko: { strict_min_version: string } };
      }
    ).browser_specific_settings;

    expect(Number.parseInt(gecko.strict_min_version)).toBeGreaterThanOrEqual(140);
  });

  // Without a gecko_android key, Firefox offers the add-on on desktop only, and Haystack doesn't
  // target Android.
  it("is offered on desktop Firefox only", () => {
    expect(manifestFor("firefox", "1.2.3")).not.toHaveProperty(
      "browser_specific_settings.gecko_android",
    );
  });
});

describe("buildExtension", () => {
  it("refuses a bad origin before building anything", async () => {
    await using outDir = await mkdtempDisposable(join(tmpdir(), "haystack-extension-"));
    const target = join(outDir.path, "chrome");

    await expect(
      buildExtension({ origin: "http://haystack.example", browser: "chrome", outDir: target }),
    ).rejects.toThrow("must use https:");
    expect(await readdir(outDir.path)).toEqual([]);
  });

  describe("the Chrome build", () => {
    let files: string[];
    let manifest: Record<string, unknown> & { action: { default_popup: string } };
    let scripts: string[];
    let styles: string[];

    // One build for every check below. The files are read into memory, so the directory can go.
    beforeAll(async () => {
      await using outDir = await mkdtempDisposable(join(tmpdir(), "haystack-extension-"));
      await buildExtension({ origin: ORIGIN, browser: "chrome", outDir: outDir.path });
      files = await readdir(outDir.path, { recursive: true });
      manifest = JSON.parse(await readFile(join(outDir.path, "manifest.json"), "utf8"));
      scripts = await Promise.all(
        files
          .filter((file) => file.endsWith(".js"))
          .map((file) => readFile(join(outDir.path, file), "utf8")),
      );
      styles = await Promise.all(
        files
          .filter((file) => file.endsWith(".css"))
          .map((file) => readFile(join(outDir.path, file), "utf8")),
      );
    });

    it("is a Manifest V3 extension whose toolbar button opens the popup page", () => {
      expect(manifest.manifest_version).toBe(3);
      expect(files).toContain(manifest.action.default_popup);
    });

    // The plan's whole permission model: no host permissions, storage, or identity.
    it("asks only for activeTab and scripting", () => {
      expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
      expect(manifest).not.toHaveProperty("host_permissions");
      expect(manifest).not.toHaveProperty("optional_permissions");
    });

    // The popup does everything (Q4), so there is nothing that runs in the background or in
    // every page.
    it("has no background script and no content scripts", () => {
      expect(manifest).not.toHaveProperty("background");
      expect(manifest).not.toHaveProperty("content_scripts");
    });

    // The popup calls `browser` with promises, which Chrome has had since 148.
    it("requires a Chrome with the browser namespace", () => {
      expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(148);
    });

    it("takes its version from package.json", async () => {
      const packageJson = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      );
      expect(manifest.version).toBe(packageJson.version);
    });

    // The popup shares the site's tokens file (plan, "Design"), so its stylesheet carries the
    // same palette, and the fonts the tokens name travel with their licenses.
    it("styles the popup with the site's tokens, fonts and font licenses", async () => {
      const tokens = await readFile(
        new URL("../../web/public/assets/tokens.css", import.meta.url),
        "utf8",
      );
      const ground = /--color-ground:\s*(#[0-9a-f]+);/.exec(tokens)?.[1];
      expect(ground).toBeDefined();
      expect(styles.join("")).toContain(`--color-ground:${String(ground)}`);
      // The popup's text is set in Space Grotesk.
      const fonts = files.filter((file) => file.endsWith(".woff2"));
      expect(fonts.some((file) => file.startsWith(join("assets", "space-grotesk-")))).toBe(true);
      // Every font the build bundles needs its license, whichever ones the tokens name. That
      // includes JetBrains Mono, which the popup never uses.
      for (const font of fonts) {
        const family = /^assets[/\\](.+)-latin-wght-normal-/.exec(font)?.[1];
        expect(family, font).toBeDefined();
        expect(files).toContain(join("licenses", `${String(family)}-OFL.txt`));
      }
    });

    // `define` inlines the origin as a string literal, so the check looks for the whole origin
    // between quotes. A bare substring would also match a longer host such as
    // `haystack.example.evil`. The minifier picks the quote character, so any is accepted.
    it("has the Worker's origin compiled in", () => {
      const escaped = ORIGIN.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const literal = new RegExp(`["'\`]${escaped}["'\`]`);
      expect(scripts.some((script) => literal.test(script))).toBe(true);
    });
  });
});
