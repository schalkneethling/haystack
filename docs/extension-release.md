# Releasing the browser extension

The extension is published unlisted in both stores (#116): signed on addons.mozilla.org (AMO) for Firefox, and on the Chrome Web Store for Chrome. Neither shows it in search, because Haystack lets in only the addresses in `ALLOWED_EMAILS`, so nobody else could use it. This document says how to publish a version and how to install it. Steps marked **(owner)** need Schalk's store accounts.

The vendor pages quoted here were read on 2026-11-12.

## Versioning

The version is `version` in `apps/extension/package.json`, and the build copies it into both manifests. Both stores refuse a version number they have already seen: AMO requires a version that is "unique across all channels" (https://mozilla.github.io/addons-server/topics/api/addons.html), and Chrome requires that "each new version must have a larger version number than the previous version" (https://developer.chrome.com/docs/webstore/update).

- **When:** bump it once per release, in a pull request of its own, right before publishing. Merging it to `main` means the commit that is published carries the version it is published as.
- **How:** raise the third number for a fix, and the second for a change people notice, such as a new field. Chrome accepts one to four numbers, and `manifest.ts` refuses anything else at build time.
- **Same number in both stores:** publish every version to both, even if a change only matters in one browser, so a version number always means the same code.

## One-time setup (owner)

1. **AMO:** sign in at https://addons.mozilla.org/developers/ and accept the distribution agreement. Then create API credentials at https://addons.mozilla.org/en-US/developers/addon/api/key/. The page gives a "JWT issuer" and a "JWT secret". Keep both in your password manager, never in the repository or a `.env` file in it.
2. **Chrome Web Store:** register at https://developer.chrome.com/docs/webstore/register. Registration is a one-time fee, which the dashboard shows. The account's email address cannot be changed afterwards. 2-Step Verification must be on before you can publish (https://developer.chrome.com/docs/webstore/program-policies/policies).

## Publishing a version

Start from a clean checkout of `main` that includes the version bump. Run `vp install` first.

### Firefox

web-ext reads the two credentials from `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` (https://extensionworkshop.com/documentation/develop/web-ext-command-reference/). Paste them at the prompts `read -rs` gives, which don't show what you type, rather than into the command itself, because the shell saves every command line in its history file:

```sh
read -rs "WEB_EXT_API_KEY?JWT issuer: " && export WEB_EXT_API_KEY && echo
read -rs "WEB_EXT_API_SECRET?JWT secret: " && export WEB_EXT_API_SECRET && echo
vp run @haystack/extension#sign:firefox
unset WEB_EXT_API_KEY WEB_EXT_API_SECRET
```

The `name?prompt` form is zsh's, the macOS default. In bash, use `read -rsp "JWT issuer: " WEB_EXT_API_KEY` instead.

The script does three things:

1. `package:source` stops if the checkout has any change (`check:clean`), then writes the last commit to `apps/extension/dist/packages/haystack-source.zip`, with `apps/extension/README.md` at its root. AMO requires the source of every version whose code was bundled or minified, unlisted ones included, with a README that explains how to build it (https://extensionworkshop.com/documentation/publish/source-code-submission/).
2. `build:production` builds against `https://haystack.volume4-schalk.workers.dev`.
3. `web-ext sign --channel unlisted` uploads the build and the source archive. Every version goes through automated validation, and signing "can take up to 24 hours" (https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/). web-ext waits 15 minutes, then downloads the signed `.xpi` file into `apps/extension/dist/packages`. If it times out, the version is still being signed: download the file from the version's page in the Developer Hub once it's ready. Don't run `sign:firefox` again for the same version. The rebuild deletes web-ext's record of the upload, so it would upload the version a second time, which AMO refuses.

The signing is scripted because web-ext is Mozilla's own tool, it is maintained (10.8.0 was released on 2026-10-15), and it is already a dependency for linting.

### Chrome

```sh
vp run @haystack/extension#package
```

Like signing, this stops if the checkout has any change. It writes `haystack-chrome-<version>.zip` (and Firefox's unsigned `haystack-firefox-<version>.zip`) to `apps/extension/dist/packages`. Then, in the Chrome Web Store Developer Dashboard **(owner)**:

- **First version:** create a new item from the zip, then fill in the tabs below. Review usually takes a few days, but "it can take up to a few weeks" (https://developer.chrome.com/docs/webstore/review-process). After approval you have 30 days to publish.
- **Later versions:** upload the new zip to the existing item with "Upload New Package" (https://developer.chrome.com/docs/webstore/update), and submit it for review.

The first version needs these tabs:

| Tab               | What to enter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Store listing     | A description, a category such as Productivity, the language, and at least one 1280×800 screenshot (https://developer.chrome.com/docs/webstore/cws-dashboard-listing). The icon comes from the zip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Privacy practices | **Single purpose:** "Saves the current page to the user's own Haystack bookmark collection." **activeTab:** "Reads the address, title and description of the tab the user is on, only when they click the toolbar button." **scripting:** "Runs one function in that tab to read its title, description, canonical link and Open Graph tags, which the tab's address alone doesn't give." **Remote code:** none. **Data usage:** choose the data types that cover the pages' addresses (web history) and their titles and descriptions (website content), and certify the limited use policy. Google's documentation doesn't list the checkboxes' exact labels. **Privacy policy:** the URL of Haystack's privacy policy page. |
| Test instructions | Optional, but reviewers can't sign in, because Haystack lets in only the addresses in `ALLOWED_EMAILS`. The tab is for items that need "restricted credentials" (https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions). Never put a real account's credentials there. Explain instead what reviewers can see without one: "Haystack is a personal bookmarking app with a single user, so its pages need that user's Google sign-in. Click the toolbar button on any https page: the extension opens a new tab on https://haystack.volume4-schalk.workers.dev/save with the page's address, title and description in the URL, and that page asks for sign-in. The extension makes no other request."      |
| Distribution      | Visibility: **Unlisted**, which "does not create a listing on the Chrome Web Store" but lets anyone with the store link install it (https://developer.chrome.com/docs/webstore/cws-dashboard-distribution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A privacy policy is required because the extension sends a page's address, title and description to Haystack (https://developer.chrome.com/docs/webstore/program-policies/policies). The page is #116's next pull request, so the first Chrome submission waits for it.

The Chrome Web Store API could upload versions from a script, but it needs a Google Cloud project, an OAuth client and a refresh token (https://developer.chrome.com/docs/webstore/using-api). For an extension one person updates a few times a year, the dashboard is less to set up and keep secret.

## Installing

Remove a temporary or unpacked copy first, so the two copies don't both add a toolbar button.

- **Firefox:** drag the signed `.xpi` file onto a Firefox window, or open it with File → Open File, and confirm the installation. The first time, write down what Firefox's prompt says about data collection, and check that it names the two kinds the manifest declares: browsing activity and website content.
- **Chrome:** open the item's store link, which the dashboard shows once it's published, and choose "Add to Chrome". Then pin the button from the Extensions menu.

## Updates

- **Chrome** updates the extension by itself, after each new version passes review.
- **Firefox** needs each new `.xpi` file installed by hand, in the same way. An unlisted add-on is not served from AMO, so Firefox finds updates only through an `update_url` in the manifest, which points at an update manifest you host (https://extensionworkshop.com/documentation/publish/self-distribution/). The manifest has none, because for one person and a few releases a year, a manual install is less than hosting and maintaining that file. If that changes, adding `update_url` reaches existing installs only after one more manual install (https://extensionworkshop.com/documentation/manage/updating-your-extension/).
