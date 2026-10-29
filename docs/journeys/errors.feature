Feature: Pages a person can reach by mistake
  These journeys are for anyone who lands somewhere Haystack can't help with:
  an address that doesn't exist, a save link that was built by hand, a form
  sent after their session ended, or a request that another site sent on
  their behalf. Each answer says what happened without revealing anything
  that isn't theirs and, where there is one, offers a way back. A form sent
  after the session ended usually has no page of its own, because Haystack
  sends it through sign-in and on to the page it was for. A form that Haystack
  would reject anyway gets a page before sign-in, so nothing is stored for it:
  one that carries a secret is the example the scenarios below show.

  Some of these answers are plain text rather than a page, because they are
  meant for requests that are not a person opening a page or pressing a
  button on one: a form on another site, or a request from one of Haystack's
  own scripts. The browser shows that text on an otherwise empty page.

  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/pages.test.ts
  @integration:apps/worker/test/search-switch.test.ts
  Scenario: An address that doesn't exist, while signed in
    Given I am signed in to Haystack
    When I open an address on Haystack that has no page, such as /nowhere
    Then I see the page titled "Page not found - Haystack", under the heading "Page not found"
    And the link "Go to Haystack" takes me to Haystack's home page
    And the header has "Search", "Saved links" and "Sign out", or, while search is switched off, only "Saved links" and "Sign out"

  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/pages.test.ts
  @integration:apps/worker/test/worker.test.ts
  Scenario: A sign-in address that doesn't exist
    Pages under /auth/ never look up a session, so this page has the
    wordmark-only header whether or not I am signed in.

    When I open an address under /auth/ that has no page, such as /auth/nowhere
    Then I see the heading "Page not found"
    And the header shows only the Haystack wordmark

  @integration:apps/worker/test/auth.test.ts
  Scenario: An address that doesn't exist, while signed out
    Every page outside /auth/ needs a session, so Haystack asks me to sign in
    before it says whether the page exists. The integration test checks the
    two halves apart: a page request without a session is sent to sign in with
    its own address as the return target (tested with a save link), and an
    address with no page shows "Page not found" once signed in. No test
    follows /nowhere itself through sign-in and back.

    Given I am not signed in to Haystack
    When I open /nowhere
    Then I am sent to Google to sign in
    And after I sign in, I see the heading "Page not found"

  @integration:apps/worker/test/auth.test.ts
  @integration:apps/worker/test/save-post.test.ts
  @integration:apps/worker/test/save-address.test.ts
  @integration:apps/worker/test/delete-bookmark.test.ts
  @integration:apps/worker/test/held.test.ts
  Scenario Outline: A request from another site
    Every form that changes something must come from a Haystack page. A form
    on another site that tries to save, delete, release, retry or sign me
    out is refused, even while I am signed in.

    Given I am signed in to Haystack
    When a page on another site sends a form that would <change something>
    Then the browser shows the plain text "Forbidden"
    And nothing changes in Haystack

    Examples:
      | change something                        |
      | save a link to my collection            |
      | look a page up for the address form     |
      | delete one of my saved links            |
      | release a link Haystack held back       |
      | retry a link Haystack couldn't describe |
      | sign me out                             |

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/save-post.test.ts
  Scenario: A link from another site cannot save anything by itself
    A save link only opens the save form. Nothing is saved until I press Save,
    so a site that sends me to a save link cannot add a link to my collection.

    Given I am signed in to Haystack
    When another site sends me to a Haystack save link
    Then I see the save form, filled in from the link
    And nothing is saved unless I press Save

  @playwright:apps/worker/e2e/save-form.e2e.ts
  @integration:apps/worker/test/save-post.test.ts
  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/save-form.test.ts
  Scenario: Pressing Save after my session ended
    The save form is an ordinary form, with or without JavaScript, so this
    happens either way. The likely way to get here is to leave the save form
    open until the session expires. A browser's form submission is sent to
    sign in, and sign-in returns to the save form again, with what I entered.
    The browser test reads the redirect without following it, because it
    leads to Google, and opens the return target once it has a session again.
    Only the sign-in test follows the return target through the callback.

    Given I opened the save form while I was signed in
    And I changed its title to "My own title" and its description to "My notes"
    And I left it open until my session expired
    When I press "Save"
    Then I am sent to Google to sign in
    And nothing is saved
    When I sign in with a Google account that Haystack allows
    Then I see the page titled "Not saved yet - Haystack", under the heading "Save a link"
    And it says "This link is not saved yet. Check the title and description, then press Save."
    And the Title field holds "My own title" and the Description field holds "My notes"
    When I press "Save"
    Then I see the heading "Saved"
    And the link is saved with the title "My own title" and the description "My notes"

  @integration:apps/worker/test/save-post.test.ts
  @integration:apps/worker/test/save-form.test.ts
  Scenario: Pressing Save after my session ended, when the address is too long to keep what I entered
    The values I entered travel in the address that sign-in returns to, and
    that address has a size limit. An address that fills most of it leaves no
    room for them, so the form comes back with the page's own values. No test
    covers the whole journey: the save-post test checks the return target,
    and the save-form test checks the page for a return target like it, but
    none presses Save and signs in.

    Given I opened the save form for a link with a very long address
    And I changed its title and its description
    And I left it open until my session expired
    When I press "Save"
    And I sign in with a Google account that Haystack allows
    Then I see the page titled "Not saved yet - Haystack", under the heading "Save a link"
    And it says "This link is not saved yet, and its address is too long to keep the title and description with it. Enter them again, then press Save."
    And the Title and Description fields hold the page's own values, not mine
    And nothing is saved

  @integration:apps/worker/test/save-sensitivity.test.ts
  Scenario: Pressing Save after my session ended, on a form with the warning
    The box I ticked doesn't travel through sign-in with what I entered,
    because Haystack asks Jev again when the form comes back, and the box
    answers that warning. The test checks the return target and the form it
    opens, but doesn't sign in.

    Given the save form is open for a link that Haystack thinks might be private
    And I ticked "This link does not give access to anything private" and changed the title to "My planning doc"
    And I left it open until my session expired
    When I press "Save"
    And I sign in with a Google account that Haystack allows
    Then I see the page titled "Not saved yet - Haystack", under the heading "Save a link"
    And the Title field holds "My planning doc"
    And the form shows the warning again, with the box not ticked
    And nothing is saved

  @integration:apps/worker/test/save-form.test.ts
  Scenario: Pressing Save after my session ended, with a title I can't use
    Haystack checks the title and description I entered when the form comes
    back, as it does when I press Save, so a problem shows at once. The test
    follows the return target, not the redirect that leads to it.

    Given I opened the save form while I was signed in
    And I replaced its title with spaces
    And I left it open until my session expired
    When I press "Save"
    And I sign in with a Google account that Haystack allows
    Then I see the page titled "Check the form - Haystack", under the heading "Save a link"
    And the alert says "Enter a title of up to 200 characters."
    And nothing is saved

  @integration:apps/worker/test/save-post.test.ts
  Scenario: Pressing Save after my session ended, on a form that was changed to carry a secret
    Only a form changed by hand reaches this page. Haystack checks the form
    before it sends me to sign in, because an address with a secret is never
    stored, not even for the moment it takes to sign in. It answers with the
    address form and its error, as it does for a save link that carries a
    secret. The integration test checks the status, the error, that no
    redirect or stored sign-in row holds the address, but not the page's
    title.

    Given I opened the save form while I was signed in
    And my session expired
    When a save form is sent with its address changed to one that contains an access token
    Then I am not sent to Google
    And I see the page titled "Check the address - Haystack", under the heading "Save a link", with the address form
    And the form shows the error "This link contains an access token, key, or password, so it could let anyone who has it act as you."
    And the address appears nowhere on the page
    And nothing is saved

  @integration:apps/worker/test/save-address.test.ts
  @integration:apps/worker/test/delete-bookmark.test.ts
  Scenario Outline: Pressing a button after my session ended, without JavaScript
    With JavaScript, the address form and the delete dialog say in the page
    that I am signed out instead (see address-form.feature and
    delete.feature). Their scripts ask for JSON or for anything, not for a
    page, so they get the plain text "Unauthorized" with the status 401, which
    both scripts act on. Without JavaScript the button sends an ordinary
    form, which asks for a page, so Haystack sends me to sign in. The delete
    confirmation page is reached only without JavaScript. The buttons on
    /held are covered in held.feature.

    A bookmark's button is not repeated after I sign in, because a form cannot
    be repeated by returning to its address. I land on the page I pressed the
    button on, and press it again. Continue goes on instead to the save form
    for its address, where the button is Save, and nothing is looked up before
    sign-in. The integration tests check the redirect to sign-in, which names
    the page to return to, and that nothing changes. No test signs in
    afterwards and lands on that page, but the sign-in tests follow other
    return targets, such as the saved links, through sign-in.

    Given my browser has JavaScript turned off
    And I opened <the page> while I was signed in
    And my session has ended since
    When I press <the button>
    Then I am sent to Google to sign in
    And nothing changes in Haystack
    When I sign in with a Google account that Haystack allows
    Then I land on <where I land>

    Examples:
      | the page                                   | the button        | where I land                                                     |
      | the "Save a link" page                     | "Continue"        | the save form for the address alone, not filled in from the page |
      | my saved links                             | "Delete A guide"  | my saved links                                                   |
      | the delete confirmation page from my links | "Delete"          | my saved links                                                   |

  @integration:apps/worker/test/save-address.test.ts
  Scenario: Pressing Continue after my session ended, with an address that carries a secret
    Without JavaScript, the address form's Continue is an ordinary form too.
    Haystack checks the address before it sends me to sign in, for the reason
    in the scenario above, and looks nothing up.

    Given my browser has JavaScript turned off
    And I opened the "Save a link" page while I was signed in
    And my session has ended since
    When I enter an address that contains an access token and press "Continue"
    Then I am not sent to Google
    And I see the "Save a link" address form with the error "This link contains an access token, key, or password, so it could let anyone who has it act as you."
    And the address appears nowhere on the page

  @integration:apps/worker/test/save-post.test.ts
  Scenario: A save request that isn't a form
    Only a request built by hand, such as one that sends JSON, reaches this
    page, because the save form always sends a form. The integration test
    checks that the request is refused and that nothing is saved, but not the
    page's wording, which is quoted from the code.

    Given I am signed in to Haystack
    When a request to save a link is sent with something other than a form
    Then I see the page titled "This link can't be saved - Haystack", under the heading "This link can't be saved"
    And it says "Save links from the form on the save page."
    And nothing is saved

  @playwright:apps/worker/e2e/save-form.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/address-form.test.ts
  @voiceover:apps/worker/e2e/save-pages.voiceover.ts
  Scenario: A save link with values Haystack can't use
    The extension leaves out any value that fails Haystack's checks, so only a
    link built by hand reaches this page. A link whose address fails gets the
    "Save a link" form with its error instead.

    Given I am signed in to Haystack
    When I open a save link whose address is fine but whose title is longer than 200 characters
    Then I see the page titled "This link can't be saved - Haystack", under the heading "This link can't be saved"
    And it says "The save link has values Haystack can't use:"
    And it lists "The page title: it is too long"
    And VoiceOver announces the page's title when I enter the page, then reads the heading, the sentence, the list and its item

  @playwright:apps/worker/e2e/save-form.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/save-post.test.ts
  @voiceover:apps/worker/e2e/save-pages.voiceover.ts
  Scenario: A save form that was changed to carry a secret
    The save form only ever sends addresses that passed Haystack's checks, so
    only a form changed by hand reaches this page. Haystack checks again
    before it saves.

    Given I am signed in to Haystack
    When a save form is sent with its address changed to one that contains an access token
    Then I see the page titled "This link can't be saved - Haystack", under the heading "This link can't be saved"
    And it says "This link contains an access token, key, or password, so it could let anyone who has it act as you."
    And it shows the notice about private links
    And the address appears nowhere on the page
    And nothing is saved
    And VoiceOver announces the page's title when I enter the page, then reads the heading, the reason and the notice, and never the link
