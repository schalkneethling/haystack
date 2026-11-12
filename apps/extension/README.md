# Haystack browser extension

The toolbar button that saves the current page to Haystack. It reads the current tab's address, title and description, and opens Haystack's save form with them filled in. It sends nothing anywhere else. The design is in "Extension" in `plans/haystack-v1-implementation-plan.md`, and publishing it is in `docs/extension-release.md`.

This file is also the README that addons.mozilla.org's reviewers receive with the source code of each signed version, because the extension's code is bundled and minified by Vite.

## Building it from source

The build needs macOS or Linux, Git, and Vite+, the toolchain the repository uses. Vite+ installs Node.js and pnpm itself, so neither has to be installed first: pnpm at the version in `devEngines` in the root `package.json`. The repository pins no Node.js version, so Vite+ uses your default from `vp env default`, or the latest long-term support release if you have none.

1. Install Vite+ (https://viteplus.dev/guide/):

   ```sh
   curl -fsSL https://vite.plus | bash
   ```

   Open a new terminal afterwards, so that `vp` is on the path.

2. In the root of the source archive or a clone of https://github.com/schalkneethling/haystack, install the dependencies from the lockfile, `pnpm-lock.yaml`:

   ```sh
   vp install
   ```

3. Build both browsers against the production server:

   ```sh
   vp run @haystack/extension#build:production
   ```

The Firefox build is in `apps/extension/dist/firefox`, and its files match the signed version's. Chrome's is in `apps/extension/dist/chrome`.

## What builds it

- `apps/extension/build.ts` runs Vite through Vite+, with the server's origin compiled in from `HAYSTACK_ORIGIN`. `build:production` sets it to `https://haystack.volume4-schalk.workers.dev`.
- `apps/extension/manifest.ts` writes `manifest.json`, with the version from `apps/extension/package.json`.
- The popup's source is in `apps/extension/src`, and it shares code with the server in `packages/schemas`. Its stylesheet imports the site's tokens and fonts from `apps/web/public/assets`.
- The icons in `apps/extension/public/icons` are made from `apps/extension/art/haybale.png` by `apps/extension/icons.ts`, and committed. The build copies them as they are.
