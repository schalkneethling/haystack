# User journeys

The files in this folder describe, in plain language, what a person can do with Haystack and what happens when something goes wrong. Each journey is a scenario written in Gherkin, the language that Cucumber reads, in which every step starts with Given, When or Then. The scenarios cover Milestone 1 as it is deployed, from `main` at fae17b3, and the review page at /held, which Milestone 2 adds (#129).

They are documentation, and the input for new Playwright tests. They do not run: there is no Cucumber, no other Gherkin runner and no step definitions, so nothing checks a scenario against the code except the tests named in its tags and the people who read it.

## The files

There is one file per area, and each starts with a `Feature` that says who the journeys are for and why they matter.

| File                     | What it covers                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `sign-in.feature`        | Signing in with Google, the ways sign-in can fail, coming back to the page you started on, and signing out     |
| `extension-save.feature` | Saving the current page from the extension's popup in Chrome and Firefox, and the pages it refuses             |
| `address-form.feature`   | Saving a link by typing or pasting its address in the "Save a link" form (#97, #105)                           |
| `save-form.feature`      | Confirming a link on the save form, its errors, and the "already saved" page                                   |
| `saved-links.feature`    | The saved links list, and moving through it with a screen reader                                               |
| `delete.feature`         | Deleting a link, with and without JavaScript                                                                   |
| `held.feature`           | Reviewing links that Haystack held back or couldn't describe at /held: releasing, retrying and deleting (#129) |
| `errors.feature`         | Pages a person can reach by mistake, such as a page that doesn't exist or a request from another site          |

Every message, button label, page title and heading in quotation marks is copied from the code that shows it. Where a keyboard or screen reader user's experience differs, the scenario says so, or a separate scenario describes it.

## Tags

Each scenario is tagged with the tests that cover it. A tag is the kind of test, a colon, and the test file's path from the repository's root, so a scenario can have several tags.

- `@playwright:<path>` is a browser test, run by Playwright in `apps/worker/e2e` or `apps/extension/e2e`.
- `@integration:<path>` is an integration test, which runs the Worker in the local Workers runtime and sends it requests, in `apps/worker/test`.
- `@voiceover:<path>` is a screen reader test, which drives VoiceOver on macOS through Guidepup and checks what it says, in `apps/worker/e2e/*.voiceover.ts`.
- `@unit:<path>` is a unit test of one module, such as the extension's popup logic in `apps/extension/test`.
- `@untested` marks a journey that no automated test covers.

A tag means that the test checks the behaviour the scenario describes, which was confirmed by reading the test, not guessed from its name. A test can check less than the scenario says: for example, the integration tests check that a request from another site is refused, but not the word "Forbidden" that the browser then shows. Where that matters, the scenario's description says so.

## Keeping them in step with the code

The journeys change with the behaviour they describe, in the same pull request.

- **New behaviour** gets its journey written before or with its tests, and the scenario names those tests in its tags.
- **A change to wording** that a person sees or hears, such as a message or a button label, changes every scenario that quotes it. Searching this folder for the old wording finds them.
- **A new, moved or renamed test file** changes the tags that name it.
- **A journey that loses its last test** gets `@untested`, and joins the list below.
- **A test that covers an untested journey** replaces its `@untested` tag, and the journey leaves the list below.

When the code and the plan disagree about a journey, the scenario follows the code, and the disagreement is raised so that one of them can be corrected.

## Journeys that no test covers

These are the candidates for new tests, most important first.

1. **"Saving a page in Firefox"** (`extension-save.feature`) is the main way to save a link in one of the two browsers Haystack supports. Playwright cannot load an extension in Firefox, so only the manual check under "Firefox manual check" in the plan's "Testing strategy" covers it.
2. **"The delete fails because Haystack can't be reached"** (`delete.feature`) is the one failure of the delete dialog that no browser test reaches. A Playwright test could fail the request the way `delete-dialog.e2e.ts` already answers it with an error.
3. **"Deleting every link the list shows, when I have older ones"** (`delete.feature`) shows a message that only a person with more than 50 links can see. The integration test checks only that the message is in the page's markup, hidden, and no browser test deletes every card on a full page.
4. **"A screen reader user hears why the popup refused the page"** (`extension-save.feature`) depends on a status message that no screen reader test has heard. The browser test checks the popup's text and runs axe on it.
5. **"A screen reader user hears that the dialog's buttons are busy"** (`delete.feature`) rests on what VoiceOver said in trial runs, which the plan records but no test checks.
6. **"Saving a page that Firefox doesn't let the extension read"** (`extension-save.feature`) is covered by the same manual check as the first item. The unit tests cover the same fallback with a fake browser.
