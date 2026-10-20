Feature: Saving a link by typing or pasting its address
  The "Save a link" form lets the owner of the collection save a link without
  the extension, for example on a device that doesn't have it, or for a link
  someone sent them. They type or paste the address and press Continue.
  Haystack then looks the page up and opens the save form, filled in with the
  page's title and description, so they only have to confirm it.

  The form is at the top of the saved links page, and it is also a page of its
  own at /save. Looking a page up can take a few seconds, so with JavaScript
  the form stays where it is while it waits, says that it is working, and
  handles every outcome in place. Without JavaScript the browser sends the form
  and waits for the next page, and every outcome is a page of its own.

  Haystack fetches the page only after the person presses Continue, and never
  fetches an address that carries a secret, one that is already saved, or one
  of Haystack's own.

  Background:
    Given I am signed in to Haystack

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  Scenario: Finding the form on the saved links page
    The form comes before the page's heading, so it is named as a form
    landmark. A screen reader user who moves by heading would pass it, but can
    move to it by landmark.

    When I open my saved links
    Then the form "Save a link" is at the top of the page, before the heading "Saved links"
    And its field is labelled "Save a link"
    And the hint under the label says "Paste the address of a page. You confirm its title on the next step."
    And a screen reader can reach the form as the form landmark "Save a link"

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  Scenario: Finding the form as a page of its own
    On its own page, the heading is the field's label, so the form is not
    named again.

    When I open /save with nothing after it in the address bar
    Then I see the page titled "Save a link - Haystack"
    And its heading "Save a link" is the field's label
    And the page shows the notice "Do not save links that contain access tokens, private shares, or sign-in and password reset links. Saved links are sent to the services that describe them, so a private link would no longer be private."

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario Outline: Reaching the field with the keyboard
    The header comes first on every page, with three stops before the
    content: the wordmark, "Saved links" and "Sign out".

    Given I am on <the page>
    When I press Tab four times
    Then the focus moves through the Haystack wordmark, the link "Saved links" and the button "Sign out"
    And then the field "Save a link" has focus

    Examples:
      | the page               |
      | my saved links         |
      | the "Save a link" page |

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/save-address.test.ts
  Scenario Outline: Saving a page whose title and description are filled in for me
    Given I am on <the page>
    When I <enter> the address of a page that has a title and a description
    And I press Enter
    Then Continue's label changes to "Processing…"
    And a moment later the message "Looking up the page. This can take a few seconds." appears under the field and takes focus
    And then the save form opens for the address, under the heading "Save a link"
    And its Title and Description fields hold the page's own title and description

    Examples:
      | the page               | enter |
      | my saved links         | type  |
      | the "Save a link" page | paste |

  @voiceover:apps/worker/e2e/address-form.voiceover.ts
  Scenario: A screen reader user hears that the page is being looked up
    The message takes focus, because VoiceOver did not read it as a status
    message or an alert in any of the ways that were measured, and read it
    every time once it had focus.

    Given I use VoiceOver
    And I have typed an address in the field "Save a link"
    When I press Continue
    Then VoiceOver reads "Looking up the page. This can take a few seconds."

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario: Continue is never disabled while the page is looked up
    A disabled button would lose focus, and a screen reader would call it
    dimmed, so Continue stays a working button and its label says what is
    happening instead.

    Given I have pressed Continue with an address, and Haystack is looking the page up
    Then the button reads "Processing…"
    And it is not disabled or dimmed
    And the message that has focus has the site's focus ring

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Saving a page without JavaScript
    Given my browser has JavaScript turned off
    And I am on the "Save a link" page
    When I enter the address of a page that has a title and a description
    And I press Continue
    Then the browser waits while Haystack looks the page up
    And then the save form opens for the address, filled in with the page's title and description

  @integration:apps/worker/test/save-address.test.ts
  @integration:apps/worker/test/save-form.test.ts
  Scenario Outline: A page that gives nothing opens the save form with the address alone
    Haystack waits at most 3 seconds for a page, and reads only its head. When
    the lookup gives nothing, the save form opens as it would for an address
    with no other details, and I can still save the link.

    Given I am on the "Save a link" page
    When I enter the address of <a page that gives nothing>
    And I press Continue
    Then the save form opens for the address
    And its Title field starts with the address itself, which I can change
    And its Description field is empty

    Examples:
      | a page that gives nothing                                |
      | a page with no title and no description                  |
      | a page that does not answer within 3 seconds             |
      | a page that stops sending before its head ends           |
      | a page that answers with an error, such as "not found"   |
      | a page that is not a web page, such as a JSON document   |
      | a page that declares a character set Haystack can't read |
      | a page that cannot be reached                            |

  @integration:apps/worker/test/save-address.test.ts
  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: An address I have already saved
    Haystack does not look the page up, because the save form shows the
    bookmark I already have instead.

    Given I have already saved a page
    And I am on the "Save a link" page
    When I enter the page's address, even with different capital letters in its host
    And I press Continue
    Then I see the heading "You already saved this link"
    And the link "See it in your saved links" takes me to it on my saved links
    And the page was not looked up again

  @integration:apps/worker/test/save-address.test.ts
  Scenario: An address on Haystack itself
    Given I am on the "Save a link" page
    When I enter the address of one of Haystack's own pages
    And I press Continue
    Then the save form opens for the address alone, and nothing was looked up

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  @integration:apps/worker/test/save-address.test.ts
  Scenario Outline: A rejected address, with JavaScript
    Every error comes from Haystack, not from the browser, so the error always
    says the rule: only complete https:// links.

    Given I am on <the page>
    When I enter "<the address>"
    And I press Enter
    Then the alert "<the error>" appears <where>
    And the field "Save a link" is marked invalid, and its description reads the error, then the hint
    And focus moves to the field
    And the field holds <what the field holds>
    And the page's title becomes "Check the address - Haystack"
    And Continue is ready to try again

    Examples:
      | the page               | the address                | the error                                                                                                                            | where                              | what the field holds |
      | my saved links         | example.com/page           | Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long. | in the form, before the hint       | what I typed         |
      | the "Save a link" page | http://example.com/page    | Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long. | after the heading, before the form | what I typed         |
      | the "Save a link" page | https://example.com/a page | Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long. | after the heading, before the form | what I typed         |
      | the "Save a link" page |                            | Enter the address of a page, starting with https://.                                                                                 | after the heading, before the form | nothing              |

  @voiceover:apps/worker/e2e/address-form.voiceover.ts
  Scenario: A screen reader user hears why the address was rejected, with JavaScript
    Given I use VoiceOver
    And I have typed "pages.test/voiceover-rejected" in the field "Save a link"
    When I press Continue
    And Haystack rejects the address
    Then focus moves to the field
    And VoiceOver reads the field with the error "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long."

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  @integration:apps/worker/test/save-address.test.ts
  Scenario: A rejected address, without JavaScript
    Focus is not moved on the page that loads. A screen reader announces its
    title, and the error is the next thing after the heading.

    Given my browser has JavaScript turned off
    And I am on the "Save a link" page
    When I enter "http://example.com/page"
    And I press Continue
    Then I see the page titled "Check the address - Haystack"
    And the alert "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long." comes right after the heading "Save a link"
    And the field still holds "http://example.com/page", marked invalid, with the error as its description
    And nothing was looked up

  @voiceover:apps/worker/e2e/save-pages.voiceover.ts
  Scenario: A screen reader user hears why the address was rejected, without JavaScript
    Given I use VoiceOver in a browser with JavaScript turned off
    And I have typed an address that starts with http:// in the field "Save a link"
    When I press Continue
    Then VoiceOver announces the page's title, "Check the address"
    And moving on from the heading "Save a link", VoiceOver reads the error "Haystack saves only secure pages, so the address must be a complete https:// link, without spaces and at most 2,048 characters long."
    And when I reach the field, VoiceOver reads it as "Save a link", invalid, with the error as its description and the address I typed

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  @integration:apps/worker/test/save-address.test.ts
  Scenario Outline: An address that carries a secret
    The address is never fetched, and Haystack never shows it back, not even in
    the field.

    Given I am on the "Save a link" page
    When I enter an address that contains <the secret>
    And I press Continue
    Then the alert says "<the reason>"
    And the field "Save a link" is empty, and the address appears nowhere on the page
    And the page was not looked up

    Examples:
      | the secret                              | the reason                                                                                          |
      | an access token                         | This link contains an access token, key, or password, so it could let anyone who has it act as you. |
      | an access token, typed without https:// | This link contains an access token, key, or password, so it could let anyone who has it act as you. |
      | a user name and password                | This link contains a user name or password, so anyone who has it could sign in with them.           |
      | a signed storage access key             | This link contains a signed access key, so it could let anyone who has it download the file.        |

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Typing something new before the secret is refused
    Given I am on the "Save a link" page
    And I pressed Continue with an address that contains an access token
    When I type something else in the field before Haystack answers
    Then the alert says why the address was refused
    And the field keeps what I typed since

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Correcting a rejected address
    Given I am on the "Save a link" page
    And I pressed Enter with an address that is missing its https://
    And the error is showing
    When I add "https://" to the start of the address
    And I press Enter
    Then the error goes away, and the page gets its own title back
    And the save form opens for the corrected address, filled in from the page

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Correcting an address on a page that already shows an error
    Given I opened a save link whose address starts with http://
    And the "Save a link" page shows its error
    When I clear the field and press Enter
    Then the alert now says "Enter the address of a page, starting with https://."
    And there is still only one alert on the page

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario Outline: The lookup fails, with JavaScript
    Each message says what to do next, and replaces the processing message,
    which keeps focus until then. Continue is ready to try again.

    Given I am on the "Save a link" page
    And I pressed Enter with an address, and Haystack is looking the page up
    When <what goes wrong>
    Then Continue's label goes back to "Continue"
    And the message "<the message>" replaces the processing message and takes focus
    And I can press Continue to try again

    Examples:
      | what goes wrong                                  | the message                                                                             |
      | Haystack has not answered after 10 seconds       | Looking up the page took too long. You can press Continue to try again.                 |
      | my connection to Haystack fails                  | Haystack could not be reached. Check your connection, then press Continue to try again. |
      | Haystack gives an answer the form doesn't expect | Something went wrong while looking up the page. You can press Continue to try again.    |

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @voiceover:apps/worker/e2e/address-form.voiceover.ts
  Scenario: I am signed out while the page is looked up
    Given I am on the "Save a link" page
    And I pressed Enter with an address, and Haystack is looking the page up
    When Haystack answers that I am no longer signed in
    Then the message "You are signed out, so the page could not be looked up. Sign in again." replaces the processing message and takes focus
    And VoiceOver reads it
    And "Sign in again" is a link that brings me back to this page after I sign in
    And I can press Continue to try again

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Pressing Continue again with the same address while it is looked up
    The lookup reaches out to someone else's site, so Haystack sends it only
    once for each press of Continue on a new address.

    Given I am on the "Save a link" page
    And I pressed Enter with an address, and Haystack is looking the page up
    When I press Shift+Tab twice to go back from the message to the field, and press Enter
    And I click the "Processing…" button
    Then the form keeps waiting for the first lookup
    And no second lookup is sent

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Pressing again while the save form is opening
    Given Haystack has answered my lookup, and the save form is still opening
    When I press Continue, or Enter in the field, with the same address
    Then no second lookup is sent

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario Outline: Changing the address while the page is looked up
    Given I am on the "Save a link" page
    And I pressed Enter with an address, and Haystack is looking the page up
    When <I send a new address>
    Then the first lookup is abandoned, and its answer is ignored if it comes
    And the save form opens for the new address, filled in from its page

    Examples:
      | I send a new address                                                            |
      | I change the address and click the "Processing…" button                         |
      | I press Shift+Tab twice to reach the field, replace the address and press Enter |

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Moving elsewhere before the processing message appears
    Given I am on the "Save a link" page
    When I press Enter with an address
    And I move focus to the link "Saved links" straight away
    Then the processing message still appears
    But focus stays on the link "Saved links"

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Going back to the field to fix the address while the page is looked up
    A failure's message does not take focus from the field, so the rest of
    what I type still goes into the field.

    Given I am on the "Save a link" page
    And I pressed Enter with an address, and Haystack is looking the page up
    When I press Shift+Tab twice to reach the field and start typing
    And the lookup fails while I type
    Then the failure's message appears
    But focus stays in the field, and everything I typed is in it

  @playwright:apps/worker/e2e/address-form.e2e.ts
  Scenario: Going back from the save form
    The browser test that goes back checks that the form is ready and shows
    no message. A browser can also restore the page as I left it, still
    looking the page up. Playwright's Chromium doesn't show whether it used
    that restored copy, so a second test sends the event a browser sends for
    a restored page, and checks that the form is ready, shows no message,
    and that nothing has focus.

    Given I entered an address on the "Save a link" page, and the save form opened for it
    When I go back in the browser
    Then the "Save a link" form is ready, with Continue's own label
    And no message is showing
    And if the browser restored the page as I left it, still looking the page up, nothing on the page has focus

  @playwright:apps/worker/e2e/address-form.e2e.ts
  @integration:apps/worker/test/address-form.test.ts
  @integration:apps/worker/test/sign-in.test.ts
  Scenario: Correcting a rejected address before I have signed in
    Before sign-in, the form doesn't look the page up. It sends me through
    sign-in to the save form for the address instead.

    Given I have signed out of Haystack
    And I opened a save link whose address starts with http://
    And I see the "Save a link" form with its error, and a header with only the Haystack wordmark
    When I correct the address and press Continue
    Then I am sent to Google to sign in
    And after I sign in, the save form opens for the address alone, not filled in from the page
