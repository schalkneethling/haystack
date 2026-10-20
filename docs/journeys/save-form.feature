Feature: Confirming and saving a link
  Whichever way a link arrives, from the extension or from the address form,
  the owner of the collection confirms it on the save form before anything is
  saved. The form shows the address, and lets them correct the title and the
  description first. Nothing is saved until they press Save, so no other site
  can add a link to their collection by sending them to a save link.

  The form is plain HTML and works the same with and without JavaScript.

  Background:
    Given I am signed in to Haystack

  @playwright:apps/worker/e2e/save-flow.e2e.ts
  @playwright:apps/extension/e2e/toolbar-button.e2e.ts
  @integration:apps/worker/test/save-form.test.ts
  Scenario: What the save form shows
    Given the save form is open for a page I have not saved yet
    Then I see the page titled "Save a link - Haystack", under the heading "Save a link"
    And it shows "Address:" followed by the page's address, which I can't edit
    And it shows the notice "Do not save links that contain access tokens, private shares, or sign-in and password reset links. Saved links are sent to the services that describe them, so a private link would no longer be private."
    And it has a Title field and a Description field, filled in from the page
    And it has a Save button

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/save-post.test.ts
  @playwright:apps/worker/e2e/save-flow.e2e.ts
  Scenario: The address is shown without its tracking parameters
    Haystack removes parameters that only track where a visit came from, such
    as utm_source, before it shows the address and before it saves it.

    Given I opened the save form from a link whose address ends with "?utm_source=mail"
    Then the address on the form has no "utm_source" in it
    And that is the address Haystack saves

  @playwright:apps/worker/e2e/save-flow.e2e.ts
  @integration:apps/worker/test/save-post.test.ts
  Scenario: Editing the title and description, then saving
    Given the save form is open for a page I have not saved yet
    When I change the title to "My guide"
    And I change the description to "How to do the thing."
    And I press Save
    Then I see the page titled "Saved - Haystack", under the heading "Saved"
    And the link "See it in your saved links" takes me to the new link on my saved links
    And my saved links show it with the title "My guide" and the description "How to do the thing."

  @playwright:apps/worker/e2e/save-form.e2e.ts
  Scenario: Completing the save form with the keyboard alone
    Given the save form is open for a page I have not saved yet
    When I press Tab three times past the header's wordmark, "Saved links" and "Sign out"
    Then the Title field has focus
    When I type a new title, and press Tab
    Then the Description field has focus
    When I press Tab
    Then the Save button has focus
    When I press Enter
    Then the link is saved with the title I typed

  @integration:apps/worker/test/save-form.test.ts
  Scenario: A screen reader user hears the address and the notice on the Save button
    The Save button is described by the address and by the notice about
    private links, so a screen reader user who goes straight to the button
    still hears what they are saving. No screen reader test checks this; the
    integration test checks the markup.

    Given I use a screen reader
    And the save form is open for a page I have not saved yet
    When I move to the Save button
    Then my screen reader reads the button with the address and the notice as its description

  @integration:apps/worker/test/save-post.test.ts
  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: Saving without a description
    Given the save form is open for a page I have not saved yet
    When I clear the Description field
    And I press Save
    Then the link is saved
    And its card on my saved links has no description

  @playwright:apps/worker/e2e/save-form.e2e.ts
  @integration:apps/worker/test/save-post.test.ts
  @voiceover:apps/worker/e2e/save-pages.voiceover.ts
  Scenario: An empty title
    The browser does not let a field marked as required stay empty, but a
    title of spaces passes its check, and Haystack trims it to nothing.

    Given the save form is open for a page I have not saved yet
    When I replace the title with spaces
    And I press Save
    Then I see the page titled "Check the form - Haystack"
    And the alert "Enter a title of up to 200 characters." comes right after the heading "Save a link"
    And the Title field is marked invalid, with the error as its description
    And the description I entered is still in its field
    And nothing was saved
    And focus is not moved, so the page starts from the top

  @voiceover:apps/worker/e2e/save-pages.voiceover.ts
  Scenario: A screen reader user hears why the title was rejected
    Given I use VoiceOver
    And the save form is open for a page I have not saved yet
    When I replace the title with spaces and press Save
    Then VoiceOver announces "Check the form"
    And moving on from the heading "Save a link", VoiceOver reads "Enter a title of up to 200 characters."
    And when I reach the Title field, VoiceOver reads it as "Title", required, invalid data, with the error as its description

  @integration:apps/worker/test/save-post.test.ts
  Scenario Outline: A title or description that is too long
    The fields stop typing at their limits, 200 characters for the title and
    300 for the description, so a person meets these errors only when the
    browser does not apply the limit, for example with a form sent by hand.

    Given the save form is open for a page I have not saved yet
    When the form is sent with <the value>
    Then I see the page titled "Check the form - Haystack"
    And the alert says "<the error>"
    And the <field> field is marked invalid, with the error as its description
    And the values I entered are still in the form
    And nothing was saved

    Examples:
      | the value                       | the error                                           | field       |
      | a title of 201 characters       | Enter a title of up to 200 characters.              | Title       |
      | a description of 301 characters | Shorten the description to 300 characters or fewer. | Description |

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/save-post.test.ts
  @unit:apps/extension/test/open-save-form.test.ts
  Scenario: A page that declares a private address for itself is still saved
    A page can name a canonical address for itself. If that address carries a
    secret, Haystack leaves it out and saves the page without it. The person
    never saw that address, so the form says nothing about it.

    Given I opened the save form for a page that declares a canonical address containing an access token
    Then the save form looks as it does for any other page
    When I press Save
    Then the link is saved without the canonical address, and the secret is stored nowhere

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/recent-saves.test.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario Outline: Opening the save form for a link I have already saved
    Haystack compares addresses without their tracking parameters and without
    the part after "#", so a link I have saved is recognised in those forms
    too.

    Given I have already saved "https://example.com/article?id=7"
    When I open the save form for "<the address>"
    Then I see the page titled "Already saved - Haystack", under the heading "You already saved this link"
    And the link "See it in your saved links" takes me to it on my saved links
    And there is no form to save it again

    Examples:
      | the address                                      |
      | https://example.com/article?id=7                 |
      | https://example.com/article?id=7&utm_source=mail |
      | https://example.com/article?id=7#comments        |

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: Opening the save form for a link I saved long ago
    My saved links show the 50 most recent, so an older link has no place on
    the page to link to.

    Given I saved a link before my 50 most recent links
    When I open the save form for it
    Then I see the heading "You already saved this link"
    And it says "It is older than the 50 most recent links that your saved links show.", where "your saved links" is a link to my saved links

  @integration:apps/worker/test/save-post.test.ts
  Scenario: Pressing Save twice
    Saving the same link at the same moment, for example with a double press,
    gives one link, and the second answer says it is already saved.

    Given the save form is open for a page I have not saved yet
    When I press Save twice in quick succession
    Then only one link is saved
    And one answer is "Saved" and the other is "You already saved this link"

  @integration:apps/worker/test/save-post.test.ts
  Scenario: Reloading the "Saved" page
    The "Saved" page is the answer to pressing Save, so reloading it sends the
    form again.

    Given I pressed Save and see the heading "Saved"
    When I reload the page and let the browser send the form again
    Then I see the heading "You already saved this link"
    And there is still only one copy of the link
