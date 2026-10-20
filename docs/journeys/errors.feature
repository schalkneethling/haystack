Feature: Pages a person can reach by mistake
  These journeys are for anyone who lands somewhere Haystack can't help with:
  an address that doesn't exist, a save link that was built by hand, a form
  sent after their session ended, or a request that another site sent on
  their behalf. Each answer says what happened without revealing anything
  that isn't theirs, and, where there is one, offers a way back.

  Some of these answers are plain text rather than a page, because they are
  meant for requests that no Haystack page sends, such as a form on another
  site. The browser shows that text on an otherwise empty page.

  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/pages.test.ts
  Scenario: An address that doesn't exist, while signed in
    Given I am signed in to Haystack
    When I open an address on Haystack that has no page, such as /nowhere
    Then I see the page titled "Page not found - Haystack", under the heading "Page not found"
    And the link "Go to Haystack" takes me to my saved links
    And the header has "Saved links" and "Sign out"

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
  Scenario Outline: A request from another site
    Every form that changes something must come from a Haystack page. A form
    on another site that tries to save, delete or sign me out is refused, even
    while I am signed in.

    Given I am signed in to Haystack
    When a page on another site sends a form that would <change something>
    Then the browser shows the plain text "Forbidden"
    And nothing changes in Haystack

    Examples:
      | change something                    |
      | save a link to my collection        |
      | look a page up for the address form |
      | delete one of my saved links        |
      | sign me out                         |

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/save-post.test.ts
  Scenario: A link from another site cannot save anything by itself
    A save link only opens the save form. Nothing is saved until I press Save,
    so a site that sends me to a save link cannot add a link to my collection.

    Given I am signed in to Haystack
    When another site sends me to a Haystack save link
    Then I see the save form, filled in from the link
    And nothing is saved unless I press Save

  @integration:apps/worker/test/save-post.test.ts
  Scenario: Pressing Save after my session ended
    The save form is an ordinary form, with or without JavaScript, so this
    happens either way. The likely way to get here is to leave the save form
    open until the session expires. The integration test checks that the
    request is refused as signed out and that nothing is saved. The wording
    is the Worker's plain-text answer.

    Given I opened the save form while I was signed in
    And I left it open until my session expired
    When I press "Save"
    Then the browser shows the plain text "Unauthorized"
    And nothing is saved
    And opening any Haystack page sends me to Google to sign in

  @integration:apps/worker/test/save-address.test.ts
  @integration:apps/worker/test/delete-bookmark.test.ts
  Scenario Outline: Pressing a button after my session ended, without JavaScript
    With JavaScript, the address form and the delete dialog say in the page
    that I am signed out instead (see address-form.feature and
    delete.feature), and the delete confirmation page is reached only without
    JavaScript. The integration tests check that the request is refused as
    signed out and that nothing changes. The wording is the Worker's
    plain-text answer.

    Given my browser has JavaScript turned off
    And I opened <the page> while I was signed in
    And my session has ended since
    When I press <the button>
    Then the browser shows the plain text "Unauthorized"
    And nothing changes in Haystack
    And opening any Haystack page sends me to Google to sign in

    Examples:
      | the page                     | the button |
      | the "Save a link" page       | "Continue" |
      | the delete confirmation page | "Delete"   |

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
