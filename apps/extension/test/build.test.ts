import { mkdtempDisposable, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { buildExtension, parseHaystackOrigin } from "../build.ts";
import { manifestFor } from "../manifest.ts";

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
    it(`refuses the version ${version}, which Chrome would not load`, () => {
      expect(() => manifestFor("chrome", version)).toThrow("must be one to four");
    });
  }
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

    it("has the Worker's origin compiled in", () => {
      expect(scripts.some((script) => script.includes(ORIGIN))).toBe(true);
    });
  });
});
