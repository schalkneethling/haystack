# Haystack

Haystack is a personal bookmarking app. You save a page from a browser extension, or by pasting its address, and Haystack describes each bookmark for you, so you can later find it again by asking for what you need in your own words. It runs on Cloudflare Workers.

Only the addresses in `ALLOWED_EMAILS` (in `apps/worker/wrangler.jsonc`) can sign in, so it is a one-person app for now. The code is public under the MIT license.

## Where things are

| Path               | What it is                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker`      | The Worker: every page, sign-in, saving, enrichment and search                                                                                           |
| `apps/web/public`  | The pages' stylesheets, fonts and scripts, and the headers they're served with, which the Worker serves as static assets                                 |
| `apps/extension`   | The browser extension for Chrome and Firefox, which opens the save form for the current page                                                             |
| `packages/schemas` | Code the Worker and the extension share, such as the checks on a saved page's fields                                                                     |
| `evals`            | The contract check: one live request to each outside API that enrichment and search call (`vp -C evals run contract`, which needs the 1Password secrets) |

The design and every decision behind it are in [the implementation plan](plans/haystack-v1-implementation-plan.md). How people use Haystack is described in [the user journeys](docs/journeys/README.md). Before changing anything, read [AGENTS.md](AGENTS.md) and [PR.md](PR.md), which say how work is done here.

## Setting up

You need macOS or Linux, Git, and [Vite+](https://viteplus.dev/guide/), the toolchain this repository uses. Vite+ installs the right versions of Node.js and pnpm itself.

1. Install Vite+, then open a new terminal so that `vp` is on your path:

   ```sh
   curl -fsSL https://vite.plus | bash
   ```

2. Install the dependencies:

   ```sh
   vp install
   ```

3. Create the local database. You only need to do this once, and again after a pull that adds a migration in `apps/worker/migrations`:

   ```sh
   vp -C apps/worker run db:migrate:local
   ```

### Secrets

The Worker needs a Google OAuth client secret for sign-in, and API keys for enrichment. In local development, [varlock](https://varlock.dev) reads them from 1Password when the Worker starts, as `apps/worker/.env.schema` declares. They never touch the disk. varlock signs in through the 1Password desktop app, so you need:

- the 1Password desktop app, with **Settings** → **Developer** → **Integrate with 1Password CLI** turned on ([1Password's guide](https://www.1password.dev/cli/app-integration/));
- the 1Password CLI, `op` ([installing it](https://www.1password.dev/cli/get-started)).

1Password then asks you to approve the access when the Worker starts.

The references point at the owner's 1Password account and its `dev` vault, so running the Worker locally needs access to them. Anyone else would have to change more than the secrets:

- in `apps/worker/.env.schema`, every `op(…)` reference and the `@initOp` account, to point at their own 1Password items;
- in `apps/worker/wrangler.jsonc`, their own `GOOGLE_CLIENT_ID`, their address in `ALLOWED_EMAILS`, their own AI Gateway (`AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`), and their own Flagship app (`app_id`);
- in their Google OAuth client, the redirect URI `http://localhost:5173/auth/callback`.

The tests need none of this: they run without secrets, and so does CI.

## Running Haystack locally

Start the Worker:

```sh
vp -C apps/worker run dev
```

It listens on http://localhost:5173. Open it, and Haystack sends you to Google to sign in with an address in `ALLOWED_EMAILS`. The session lasts 30 days in that browser profile. Stop the Worker with Ctrl+C.

Search is off until its Flagship flag, `search-enabled`, is on, so locally the home page is the saved links. The plan's "Runtime switches", under "Secrets and configuration" in [the implementation plan](plans/haystack-v1-implementation-plan.md), explains the flag.

## Running the extension locally

The extension's build has the Worker's address compiled in. While the Worker runs, build both browsers against it in a second terminal:

```sh
vp -C apps/extension run build:local
```

This writes `apps/extension/dist/chrome` and `apps/extension/dist/firefox`. Build again after every change to the extension, then reload it as below.

### Chrome

The extension needs Chrome 148 or later.

These are the steps in Chrome's [Hello World tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world):

1. Go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**, and pick the `apps/extension/dist/chrome` folder.
4. Pin "Save to Haystack" from the Extensions menu, the puzzle piece, so the button stays in the toolbar.

After a new build, choose the refresh icon next to the extension's on and off switch in `chrome://extensions`.

### Firefox

The extension needs Firefox 140 or later. A release build of Firefox installs an unsigned extension only until it quits, so load it again after every restart. These are the steps in Mozilla's [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/):

1. On macOS, open Firefox from the Dock or the Finder, not from a terminal. "Firefox manual check", under "Testing strategy" in [the implementation plan](plans/haystack-v1-implementation-plan.md), explains why a Firefox started from a terminal can fail to start.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**, and pick `apps/extension/dist/firefox/manifest.json`.

After a new build, choose **Reload** under the add-on on the same page.

Once the add-on is signed on addons.mozilla.org (#116), the local add-on will have the same ID as the signed one, so Firefox will replace one with the other. If you use the signed add-on day to day, load the local one in another Firefox profile, or in Firefox Developer Edition.

## Checking a change

Before you open a pull request, run the whole repository's checks and build the Worker, as [PR.md](PR.md) asks:

```sh
vp run quality
vp -C apps/worker build
```

`vp run quality` runs the type checks, `vp check` (formatting, linting and type checking), `vp test`, the end-to-end tests, Stylelint and Knip, and then checks the environment schema with varlock. The end-to-end tests need Playwright's Chromium, which you install once for each package, and again after a Playwright upgrade:

```sh
vp -C apps/worker run e2e:install
vp -C apps/extension run e2e:install
```

On Linux, Playwright's Chromium also needs system libraries. CI installs them with `--with-deps` (`.github/workflows/quality.yml`).
