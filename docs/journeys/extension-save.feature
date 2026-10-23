Feature: Saving the current page with the extension
  The Haystack extension, for Firefox and Chrome, is the quickest way to save a
  page: one click on its toolbar button opens Haystack's save form in a new
  tab, filled in from the page, and one click on Save confirms it. These
  journeys are for the owner of the collection while they browse. When a page
  can't be saved, the popup says why and opens nothing, so a link that carries
  a secret never leaves the browser.

  The toolbar button is labelled "Save to Haystack". The extension sets no
  keyboard shortcut of its own, so a keyboard user reaches the button the way
  their browser reaches any toolbar button.

  Playwright cannot load an extension in Firefox, so the Firefox journeys are
  covered only by the manual check under "Firefox manual check" in the plan's
  "Testing strategy", and are tagged as untested.

  Background:
    Given the Haystack extension is installed

  @playwright:apps/extension/e2e/toolbar-button.e2e.ts
  @unit:apps/extension/test/open-save-form.test.ts
  Scenario: Saving a page in Chrome
    Given I am signed in to Haystack in this browser
    And I am on a page whose address starts with https://
    When I click the "Save to Haystack" toolbar button
    Then a new tab opens with Haystack's save form, under the heading "Save a link"
    And the form shows the page's address and its title
    And the popup closes by itself

  @untested
  Scenario: Saving a page in Firefox
    The manual check in the plan's "Testing strategy" covers this journey.

    Given I am using Firefox 140 or later
    And I am signed in to Haystack in this browser
    And I am on a page whose address starts with https://
    When I click the "Save to Haystack" toolbar button
    Then a new tab opens with Haystack's save form, under the heading "Save a link"
    And the form shows the page's address and its title
    And the popup closes by itself

  @playwright:apps/extension/e2e/toolbar-button.e2e.ts
  @integration:apps/worker/test/save-form.test.ts
  Scenario Outline: The save form is filled in from what the page says about itself
    The title comes from the page's sharing title, then its document title,
    then its address. The description comes from the page's sharing
    description, then its meta description.

    Given I am signed in to Haystack in this browser
    And I am on a page that has <what the page has>
    When I click the "Save to Haystack" toolbar button
    Then the save form's Title field holds <the title>
    And its Description field holds <the description>

    Examples:
      | what the page has                                   | the title                                                                                                     | the description         |
      | a sharing title and description, and a document one | the sharing title                                                                                             | the sharing description |
      | only a document title and a meta description        | the document title                                                                                            | the meta description    |
      | no title and no description at all                  | the page's address, cut to 200 characters if it is longer, or to 199 if the 200th would split an emoji in two | nothing                 |
      | only a sharing title, longer than 200 characters    | its first 200 characters, or 199 if the 200th would split an emoji in two                                     | nothing                 |

  @playwright:apps/extension/e2e/toolbar-button.e2e.ts
  @unit:apps/extension/test/open-save-form.test.ts
  @unit:packages/schemas/test/detect-sensitive-url.test.ts
  Scenario Outline: A page whose address carries a secret is not saved
    Haystack refuses an address that works as a key, because a saved link is
    later sent to the services that describe it.

    Given I am on a page whose address contains <the secret>
    When I click the "Save to Haystack" toolbar button
    Then the popup stays open with the heading "This page can't be saved"
    And it says "<the reason>"
    And no new tab opens, so the address never leaves the browser

    Examples:
      | the secret                  | the reason                                                                                          |
      | an access token             | This link contains an access token, key, or password, so it could let anyone who has it act as you. |
      | a user name and password    | This link contains a user name or password, so anyone who has it could sign in with them.           |
      | a signed storage access key | This link contains a signed access key, so it could let anyone who has it download the file.        |

  @untested
  Scenario: A screen reader user hears why the popup refused the page
    The reason is written into a status message, which a screen reader should
    announce without the person moving to it. No screen reader test checks
    that it does. The browser test checks the popup's text and runs axe on it.

    Given I use a screen reader
    And I am on a page whose address contains an access token
    When I click the "Save to Haystack" toolbar button
    Then my screen reader announces "This link contains an access token, key, or password, so it could let anyone who has it act as you."

  @unit:apps/extension/test/open-save-form.test.ts
  Scenario Outline: A page whose address Haystack can't save
    Given I am on <the page>
    When I click the "Save to Haystack" toolbar button
    Then the popup stays open with the heading "This page can't be saved"
    And it says "<the reason>"
    And no new tab opens

    Examples:
      | the page                                                          | the reason                                                            |
      | a page whose address starts with http://                          | Haystack saves only secure pages, whose address starts with https://. |
      | one of the browser's own pages, such as a new tab                 | Haystack saves only secure pages, whose address starts with https://. |
      | a file on my computer                                             | Haystack saves only secure pages, whose address starts with https://. |
      | a page whose address is longer than 2,048 characters once encoded | This page's address is too long to save.                              |
      | a tab that has not loaded its first page yet                      | Haystack can't read this tab's address.                               |

  @unit:apps/extension/test/open-save-form.test.ts
  Scenario: Saving a page that the extension isn't allowed to read
    Browsers do not let an extension read some https pages, such as an
    extension store. The extension then uses only what the browser tells it
    about the tab.

    Given I am signed in to Haystack in this browser
    And I am on a Chrome Web Store page
    When I click the "Save to Haystack" toolbar button
    Then a new tab opens with Haystack's save form
    And the form shows the page's address, and the tab's title as the title
    And the popup closes by itself

  @untested
  Scenario: Saving a page that Firefox doesn't let the extension read
    The manual check in the plan's "Testing strategy" covers this journey, on
    addons.mozilla.org.

    Given I am using Firefox 140 or later
    And I am signed in to Haystack in this browser
    And I am on a page of addons.mozilla.org
    When I click the "Save to Haystack" toolbar button
    Then a new tab opens with Haystack's save form
    And the form shows the page's address, and the tab's title as the title
    And the popup closes by itself

  @unit:apps/extension/test/open-save-form.test.ts
  Scenario: The browser can't open the save form
    Given I am on a page whose address starts with https://
    And the browser refuses to open a new tab for the extension
    When I click the "Save to Haystack" toolbar button
    Then the popup stays open with the heading "The save form didn't open"
    And it says "Haystack couldn't open the save form. Try again."

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/sign-in.test.ts
  Scenario: Saving a page while signed out of Haystack
    Given I am not signed in to Haystack in this browser
    And I am on a page whose address starts with https://
    When I click the "Save to Haystack" toolbar button
    Then the new tab sends me to Google to sign in
    When I sign in with a Google account that Haystack allows
    Then I land on the save form for the page, filled in as the extension sent it
