// Builds the extension for one browser with Vite, through Vite+. See "## Extension" in
// plans/haystack-v1-implementation-plan.md. The Haystack origin is a build-time constant, so
// local development and production get separate builds. Run as a script, it builds Chrome into
// dist/chrome and Firefox into dist/firefox, both from HAYSTACK_ORIGIN.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isHttpsOrLoopbackUrl, LOOPBACK_HOSTS } from "@haystack/schemas";
import { build, type Plugin } from "vite-plus";
import { BROWSERS, type Browser, type Manifest, manifestFor } from "./manifest.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

const ORIGIN_EXAMPLES = "for example https://haystack.example.com or http://localhost:5173";

/**
 * The Worker's origin from HAYSTACK_ORIGIN, or an error that says what is wrong with it. It must
 * be an origin alone, using https:, or http: on a loopback host for local development.
 */
export function parseHaystackOrigin(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `HAYSTACK_ORIGIN is not set. Set it to the Worker's origin, ${ORIGIN_EXAMPLES}.`,
    );
  }
  const url = URL.parse(value.trim());
  if (url === null) {
    throw new Error(
      `HAYSTACK_ORIGIN "${value}" is not a URL. Use the Worker's origin, ${ORIGIN_EXAMPLES}.`,
    );
  }
  if (!isHttpsOrLoopbackUrl(url)) {
    throw new Error(
      `HAYSTACK_ORIGIN "${value}" must use https:. Only ${[...LOOPBACK_HOSTS].join(", ")} may use http:.`,
    );
  }
  if (url.href !== `${url.origin}/`) {
    throw new Error(
      `HAYSTACK_ORIGIN "${value}" must be an origin only, without a user name, path, query or fragment, ${ORIGIN_EXAMPLES}.`,
    );
  }
  return url.origin;
}

// Writes manifest.json into the build, so the manifest exists only as the typed object.
function manifestPlugin(manifest: Manifest): Plugin {
  return {
    name: "haystack-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

async function packageVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL("./package.json", import.meta.url), "utf8"),
  );
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error("apps/extension/package.json has no version");
  }
  return packageJson.version;
}

export interface BuildOptions {
  /** The Worker's origin, usually HAYSTACK_ORIGIN. It is checked before anything is built. */
  origin: string | undefined;
  browser: Browser;
  /** Emptied first, then written: the directory to load as an unpacked extension. */
  outDir: string;
}

/** Builds the extension for one browser, with the Worker's origin compiled in. */
export async function buildExtension({ origin, browser, outDir }: BuildOptions): Promise<void> {
  const haystackOrigin = parseHaystackOrigin(origin);
  const manifest = manifestFor(browser, await packageVersion());
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    // Only the popup entry reads it. The modules it calls take the origin as a parameter.
    define: { __HAYSTACK_ORIGIN__: JSON.stringify(haystackOrigin) },
    build: {
      outDir,
      emptyOutDir: true,
      // The polyfill would be dead code. Every browser the manifest allows supports modulepreload
      // natively, so the polyfill returns at once, and the popup is one entry with no dynamic
      // imports, so there is nothing to preload. It is also the bundle's only `fetch` call,
      // which anyone checking that the extension makes no requests of its own would have to
      // rule out.
      modulePreload: { polyfill: false },
    },
    plugins: [manifestPlugin(manifest)],
  });
}

if (import.meta.main) {
  try {
    for (const browser of BROWSERS) {
      await buildExtension({
        origin: process.env.HAYSTACK_ORIGIN,
        browser,
        outDir: fileURLToPath(new URL(`./dist/${browser}`, import.meta.url)),
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
