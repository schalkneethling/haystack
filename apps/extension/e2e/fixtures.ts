// The extension loaded unpacked into Chromium, next to a Worker started with the Worker's test
// harness. See "Testing strategy" in plans/haystack-v1-implementation-plan.md for what these
// fixtures rely on and why.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type HaystackWorker, startHaystackWorker } from "@haystack/worker/e2e/fixtures";
import { type BrowserContext, chromium, expect, type Page, test as base } from "@playwright/test";
import { buildExtension } from "../build.ts";

interface FixturePages {
  /** Serves an HTML document at an https URL, through a route, so no network is used. */
  serve(url: string, html: string): void;
}

interface Toolbar {
  /** Clicks the extension's toolbar button on a page's tab, and returns the popup. */
  click(page: Page): Promise<Page>;
}

function onlyOne<T>(items: readonly T[], description: string): T {
  const [item, ...others] = items;
  if (item === undefined || others.length > 0) {
    throw new Error(`Expected one ${description}, found ${items.length}`);
  }
  return item;
}

// Clicks the toolbar button the way Chromium does, through the DevTools protocol's
// Extensions.triggerAction, so the popup gets the same activeTab grant as from a real click.
// The command takes the tab target, not the page target that Playwright's pages map to.
async function clickToolbarButton(context: BrowserContext, page: Page): Promise<Page> {
  const browser = context.browser();
  if (browser === null) {
    throw new Error("The persistent context has no browser to send DevTools commands to");
  }
  const cdp = await browser.newBrowserCDPSession();
  try {
    // --disable-extensions-except leaves only Haystack's extension, which has no service
    // worker to read its ID from.
    const { extensions } = await cdp.send("Extensions.getExtensions");
    const extension = onlyOne(extensions, "unpacked extension");
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
    const tab = onlyOne(
      targetInfos.filter((target) => target.url === page.url()),
      `tab showing ${page.url()}`,
    );
    const popupOrigin = `chrome-extension://${extension.id}/`;
    const popup = context.waitForEvent("page", {
      predicate: (opened) => opened.url().startsWith(popupOrigin),
    });
    await cdp.send("Extensions.triggerAction", { id: extension.id, targetId: tab.targetId });
    return await popup;
  } finally {
    await cdp.detach();
  }
}

export const test = base.extend<
  {
    signIn: () => Promise<void>;
    fixturePages: FixturePages;
    toolbar: Toolbar;
    workerRequests: undefined;
  },
  { haystackWorker: HaystackWorker; extensionDir: string }
>({
  // The Worker starts with the Worker package's page fixture, which fails any request the Worker
  // makes that no test planned for, such as a lookup of a page on the internet. It is checked
  // after each test, so that a failure points to the test that caused it, and not only to the
  // Worker's close at the end.
  workerRequests: [
    async ({ haystackWorker }, use) => {
      haystackWorker.reset();
      await use(undefined);
      expect(
        haystackWorker.pages.unplanned,
        "requests the Worker made that no test planned for",
      ).toEqual([]);
    },
    { auto: true },
  ],
  haystackWorker: [
    // Playwright reads fixture dependencies from this destructuring pattern, so it must be one.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const worker = await startHaystackWorker();
      try {
        await use(worker);
      } finally {
        await worker.close();
      }
    },
    { scope: "worker" },
  ],
  // The origin is compiled into the build, and the harness picks its port when it starts, so
  // each test worker builds its own copy.
  extensionDir: [
    async ({ haystackWorker }, use) => {
      const outDir = await mkdtemp(join(tmpdir(), "haystack-extension-"));
      try {
        await buildExtension({ origin: haystackWorker.origin, browser: "chrome", outDir });
        await use(outDir);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  context: async ({ extensionDir, haystackWorker, headless }, use) => {
    const userDataDir = await mkdtemp(join(tmpdir(), "haystack-profile-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // Playwright's Chromium build, which can load unpacked extensions headless.
      channel: "chromium",
      headless,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        // Playwright does not see the first request of a tab that the extension opens, so its
        // routes cannot stop that request. Resolving no host but the Worker's keeps it local.
        `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${new URL(haystackWorker.origin).hostname}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
  // Every request goes to the Worker, the extension, or a fixture page. Anything else is
  // aborted, and fails the test.
  fixturePages: [
    async ({ context, haystackWorker }, use) => {
      const pages = new Map<string, string>();
      const unexpected: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === haystackWorker.origin || url.protocol === "chrome-extension:") {
          await route.continue();
          return;
        }
        const html = pages.get(url.href);
        if (html !== undefined) {
          await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
          return;
        }
        // Chromium asks each fixture site for its icon.
        if (url.pathname === "/favicon.ico" && [...pages.keys()].some(sameOrigin(url))) {
          await route.fulfill({ status: 404 });
          return;
        }
        unexpected.push(url.href);
        await route.abort("blockedbyclient");
      });
      await use({
        serve: (url, html) => {
          pages.set(new URL(url).href, html);
        },
      });
      expect(unexpected, "requests to anything but the Worker and the fixture pages").toEqual([]);
    },
    { auto: true },
  ],
  // The session as a real cookie, so it is also sent on the first request of a tab that the
  // extension opens, which Playwright's extra HTTP headers miss. A __Host- cookie needs Secure,
  // which addCookies sets only with a domain and path: from an http: `url` it would clear it.
  signIn: async ({ context, haystackWorker }, use) => {
    await use(async () => {
      const { name, value } = await haystackWorker.createSession();
      await context.addCookies([
        {
          name,
          value,
          domain: new URL(haystackWorker.origin).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    });
  },
  toolbar: async ({ context }, use) => {
    await use({ click: (page) => clickToolbarButton(context, page) });
  },
});

function sameOrigin(url: URL): (other: string) => boolean {
  return (other) => new URL(other).origin === url.origin;
}

export { expect } from "@playwright/test";
