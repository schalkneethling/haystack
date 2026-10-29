Feature: Confirming and saving a link
  Whichever way a link arrives, from the extension or from the address form,
  the owner of the collection confirms it on the save form before anything is
  saved. The form shows the address, and lets them correct the title and the
  description first. Nothing is saved until they press Save, so no other site
  can add a link to their collection by sending them to a save link.

  Before it shows the form, and again when they press Save, Haystack asks
  Jev, a model, how likely it is that the link gives access to something
  private (#132). Jev never sees the address itself, only a description of it
  with its values left out. When the answer is at or above the threshold, the
  form warns, and asks them to confirm that the link isn't private before it
  saves it. It is a warning and never a refusal, because Jev can be wrong.

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
    The header's stops are with search switched on, as the browser tests run.
    While it is off, the header has no "Search", so there is one stop fewer.

    Given the save form is open for a page I have not saved yet
    When I press Tab five times
    Then the focus moves through the Haystack wordmark, the links "Search" and "Saved links" and the button "Sign out"
    And then the Title field has focus
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
    And the alert "Enter a title of up to 200 characters." comes first in the message bar, right after the heading "Save a link"
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
  @integration:apps/worker/test/save-address.test.ts
  @unit:apps/extension/test/open-save-form.test.ts
  @unit:packages/schemas/test/screen-canonical-url.test.ts
  @playwright:apps/extension/e2e/toolbar-button.e2e.ts
  @integration:apps/worker/test/save-sensitivity.test.ts
  Scenario: A page that declares a private address for itself is still saved
    A page can name a canonical address for itself. If that address carries a
    secret, Haystack leaves it out and saves the page without it. The person
    never saw that address, so the form says nothing about it. Haystack keeps
    only the fact that the page declared such an address, as a yes or no and
    never the address, and its check of whether the link looks private uses
    that fact as a strong sign that it does. So the form may still warn that
    the link looks private, as the scenario "The check knows that the page
    declared a private address for itself" describes. The fact reaches the
    save form whether the page was read by the extension, by the address form
    or by a link someone built by hand. The browser test checks the
    extension's link and the form it opens, and the integration tests check
    the form, what Jev is sent and what is stored. No test makes Jev warn for
    such a page, because how Jev answers is Jev's.

    Given I opened the save form for a page that declares a canonical address containing an access token
    Then the save form says nothing about that address, and never shows it
    And the form may warn that the link looks private, because the page declared such an address
    When I press Save
    Then the link is saved without the canonical address, and the secret is stored nowhere
    And Haystack has recorded that the page declared an address with a secret

  @integration:apps/worker/test/save-sensitivity.test.ts
  Scenario: The check knows that the page declared a private address for itself
    A page that names a canonical address with a secret in it is a strong
    sign that its own address is a private share too, so Haystack tells Jev,
    as a yes or no, that the page declared such an address. It never sends
    the address itself, in any form. A page that declared no such address is
    checked without that statement. The integration test checks what Jev is
    sent and what is stored, not how Jev answers.

    Given I opened the save form for a page that declares a canonical address containing an access token
    Then Haystack's check tells Jev that the page declared an address with a secret
    And nothing Haystack sends to Jev contains that address, or any part of it
    When I press Save
    Then the check on Save tells Jev the same
    And the link is saved with the fact recorded, and without the address

  @integration:apps/worker/test/save-sensitivity.test.ts
  @playwright:apps/worker/e2e/save-sensitivity.e2e.ts
  Scenario: Saving a link that Haystack warns might be private, after ticking the box
    A private share can look like any other address, with no part that
    Haystack's own check recognizes, so only Jev's answer can warn about it.

    Given the save form is open for a link that Haystack thinks might be private
    Then right after the notice about private links, the form says "This link looks as if it might be private. Haystack checked its address, and it looks like a link that lets in anyone who has it, such as a private share, an invitation, or a sign-in or download link. Save it only if it doesn't give access to anything private."
    And it has the checkbox "This link does not give access to anything private", not ticked, with the warning as its description
    When I tick "This link does not give access to anything private"
    And I press Save
    Then I see the heading "Saved"
    And Haystack records that I confirmed the link isn't private

  @playwright:apps/worker/e2e/save-sensitivity.e2e.ts
  Scenario: Pressing Save without ticking the box
    The checkbox is required, so the browser asks for it before it sends the
    form, with or without JavaScript.

    Given the save form is open for a link that Haystack thinks might be private
    When I press Save without ticking "This link does not give access to anything private"
    Then the browser asks me to tick the box, and sends nothing
    And nothing is saved

  @integration:apps/worker/test/save-sensitivity.test.ts
  @playwright:apps/worker/e2e/save-sensitivity.e2e.ts
  Scenario: The form comes back when it was sent without the box
    Haystack checks the link again when I press Save, rather than trusting the
    form. So a form that showed no box, because the first check found nothing
    or got no answer, can come back with one, and so can a form sent without
    its required box, for example by hand.

    Given the save form is open for a link, and shows no warning
    And Haystack's check when I press Save thinks the link might be private
    When I change the title to "My planning doc" and press Save
    Then I see the page titled "Check the form - Haystack"
    And the alert "Tick “This link does not give access to anything private” to save this link." comes first in the message bar, right after the heading "Save a link"
    And the form shows the warning, and the checkbox, marked invalid, with the error and then the warning as its description
    And the title I entered is still in its field
    And nothing was saved
    And focus is not moved, so the page starts from the top
    When I tick "This link does not give access to anything private" and press Save
    Then I see the heading "Saved"

  @integration:apps/worker/test/save-sensitivity.test.ts
  Scenario: A rejected title on a form with the warning
    Given the save form is open for a link that Haystack thinks might be private
    When I tick "This link does not give access to anything private"
    And I replace the title with spaces and press Save
    Then the alert "Enter a title of up to 200 characters." comes first in the message bar, right after the heading "Save a link"
    And the form still shows the warning, with the box ticked
    And nothing was saved

  @voiceover:apps/worker/e2e/save-sensitivity.voiceover.ts
  Scenario: A screen reader user hears the warning before the box
    Given I use VoiceOver
    And the save form is open for a link that Haystack thinks might be private
    When I read the form from the heading "Save a link"
    Then VoiceOver reads the notice about private links, then the warning, then the checkbox
    And when I move straight to the checkbox, VoiceOver reads "This link does not give access to anything private", checkbox, with the warning as its description

  @integration:apps/worker/test/save-sensitivity.test.ts
  @playwright:apps/worker/e2e/save-sensitivity.e2e.ts
  Scenario: A link that Haystack doesn't think is private has no warning
    Given the save form is open for a link that Haystack doesn't think is private
    Then the form has neither the warning nor the checkbox
    When I press Save
    Then the link is saved

  @integration:apps/worker/test/save-sensitivity.test.ts
  @integration:apps/worker/test/save-enrichment.test.ts
  @playwright:apps/worker/e2e/save-sensitivity.e2e.ts
  Scenario: Saving when Haystack can't check the link
    Jev can be down, slow or unreachable. The check waits 2 seconds at most,
    and saving never depends on it. Haystack checks the link again right
    after saving it, and in a later run if that gets no answer either, before
    it sends anything about it to the services that describe links. The
    save tests check the form and the save, save-enrichment.test.ts checks
    the check right after saving, and the enrichment module's tests check
    the later one.

    Given Jev gives Haystack no answer about the link in time
    When I open the save form for it
    Then the form has neither the warning nor the checkbox
    When I press Save
    Then the link is saved
    And Haystack checks it again right after saving it, before it describes it

  @integration:apps/worker/test/save-enrichment.test.ts
  Scenario: Haystack describes a new link right after it is saved
    Once a link is saved, Haystack asks the services that describe links
    about it straight away (#133), and the "Saved" page doesn't wait for
    them. So a new link is usually described within seconds, rather than at
    Haystack's next hourly run. The integration test holds the description
    service's answer, and checks that the "Saved" page arrives while it is
    held and that the description is stored once it is released. No page
    shows descriptions yet, so the test checks what is stored.

    Given the save form is open for a page I have not saved yet
    When I press Save
    Then I see the heading "Saved" without waiting for Haystack to describe the link
    And Haystack describes the link straight after

  @integration:apps/worker/test/save-enrichment.test.ts
  Scenario: Haystack can't describe a new link right after it is saved
    A service that describes links can be down, slow, or refuse Haystack's
    request. The link is saved either way, and Haystack's hourly run tries
    to describe it again. One failure never moves a link under "Not
    described" on /held. The integration test checks the link's state, which
    /held reads, and that the hourly run picks the link, not the /held page
    itself.

    Given the service that describes links fails when I save a link
    When I press Save
    Then I see the heading "Saved"
    And Haystack tries to describe the link again in a later run
    And the link isn't under "Not described" on /held

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
