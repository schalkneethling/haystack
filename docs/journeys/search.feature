Feature: Searching my saved links
  The search page is Haystack's home page, at /. The owner of the collection
  describes what they are looking for in their own words, and the page shows
  the links that match as cards, each with its title and description. It is
  built for the keyboard and for a screen reader: focus stays in the field,
  the count of matches is announced, and each result is a heading.

  Searching itself comes with Phase 11 (#214). Until then, the browser tests
  answer every search with a stubbed answer, and Haystack's own search answers
  "not found", so every real search fails, as the scenario "A search that
  fails" describes. So the search page is behind a switch, the
  `search-enabled` flag, which the owner turns on when search is released
  (#218). Until then the home page is the saved links, and the header has no
  "Search" link. Every scenario but the first is with the switch on, as the
  browser tests run. Deleting a link from the results comes with #208.

  A search waits on the service that judges each link, so it can be slow, and
  it can fail for some of the links or for all of them. The page says while
  it is searching, shows what it found with a notice when some links could not
  be searched, and shows an error with a way to try again when the search
  failed, never an empty list, which would look like nothing matched (#207).

  Background:
    Given I am signed in to Haystack

  @integration:apps/worker/test/search-switch.test.ts
  @integration:apps/worker/test/flags.test.ts
  Scenario: Before search is switched on
    The switch is off until the owner turns it on, and it is off too when
    Haystack can't read it, for example during an outage of the service that
    holds it. The integration test checks the redirect and the header.

    Given search is switched off
    When I open Haystack's home page
    Then I land on my saved links, at /saved-links
    And the header has the links "Saved links" and "Sign out", but no "Search"

  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Opening the search page
    Given search is switched on
    When I open Haystack's home page
    Then I see the page titled "Search - Haystack", under the heading "Search your saved links"
    And the heading is the label of the search field, with the hint "Describe what you're looking for in your own words."
    And the header's link "Search" is marked as the current page
    And the page shows the notice "Do not save links that contain access tokens, private shares, or sign-in and password reset links. Saved links are sent to the services that describe them, so a private link would no longer be private."

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario Outline: Searching, and how many links match
    The page says how many links match in its live region, which a screen
    reader is to announce (see "Hearing how many links match with a screen
    reader").

    Given my search for "<query>" finds <found>
    When I type "<query>" in the field and press Enter
    Then the page says "<message>"
    And it shows <cards>

    Examples:
      | query      | found       | message                             | cards                             |
      | testing    | two links   | 2 saved links match your search.   | two cards, in the order found     |
      | one        | one link    | 1 saved link matches your search.  | one card                          |
      | nothing    | no link     | No saved links match your search.  | no cards, and no error            |

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Searching again replaces the results
    Given I searched for "first", and the page shows what it found
    When I search for "second"
    Then the page shows only what "second" found

  @playwright:apps/worker/e2e/search.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario: A slow search
    A disabled button would lose focus, and a screen reader would call it
    dimmed, so the button stays a working button, as Continue does on the
    "Save a link" form, and its label says what is happening instead. A search
    that answers within half a second never shows the message.

    When I search, and Haystack takes a while to answer
    Then the button "Search" reads "Processing…"
    And it is not disabled or dimmed
    And a moment later the page says "Searching your saved links. This can take a few seconds."
    And the field still has focus
    When Haystack answers
    Then the button reads "Search" again, and the page says how many links match

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Pressing Search again while it searches
    Given I searched for "testing", and Haystack has not answered yet
    When I press Enter in the field, or the button "Processing…", with the same query
    Then nothing more is sent
    And the page shows what the first search finds, when Haystack answers it

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Searching again before the first answer arrives
    The page stops waiting for the first search, so its answer is not used. An
    answer that was already on its way is ignored too.

    Given I searched for "first", and Haystack has not answered yet
    When I search for "second"
    Then the search for "first" is stopped, and "second" is sent
    When Haystack answers "second", and then, late, "first"
    Then the page shows only what "second" found, and says how many that is
    And the answer to "first" changes nothing

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Emptying the field while it searches
    Given I searched, and Haystack has not answered yet
    When I press Enter with nothing but spaces in the field
    Then the search is stopped, and the button reads "Search" again
    And the page says "Type what you're looking for, then press Search."

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: A search that takes too long
    The page waits 30 seconds for an answer.

    Given I searched, and Haystack has not answered after 30 seconds
    Then the page stops waiting
    And it shows the error "Searching your saved links took too long." with the button "Try again", in place of the results
    And the button reads "Search" again, and the field still has focus
    When I press Enter in the field
    Then the same query is searched again

  @playwright:apps/worker/e2e/search.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario Outline: Results that may be incomplete
    Some of my links could not be searched, so a link that wasn't searched may
    match. The page shows what the others found, and says so in the same
    message as the count. When nothing was found, it doesn't say that nothing
    matches.

    Given some of my links could not be searched, and my search finds <found> among the others
    When I search
    Then the page says "<message> Some of your links could not be searched, so there may be more matches. You can press Search to try again."
    And it shows <cards>

    Examples:
      | found     | message                                                     | cards     |
      | two links | 2 saved links match your search.                            | two cards |
      | no link   | None of the links that could be searched match your search. | no cards  |

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Searching for nothing
    When I press Enter with nothing but spaces in the field
    Then the page says "Type what you're looking for, then press Search."
    And nothing is searched

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: What a result shows
    Given my search finds "A guide", with the description "First line" and "Second line" on two lines
    When I search
    Then its card shows the title "A guide" as a heading, which links to the saved page
    And under it the description, on two lines
    And nothing else: not the address, nor the date it was saved
    And the saved site is not told that I came from Haystack, when I follow the link

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Only a secure address is a link
    Haystack saves only https links, and a result's title links to its address
    only when it is a complete https:// address, by the same rule as the saved
    links page.

    Given my search finds a link whose address is not a complete https:// address, such as "javascript:alert(1)"
    When I search
    Then its title is shown, but not as a link

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: A title or description that looks like markup
    Given my search finds a link titled "Title <img src=x onerror=…>"
    When I search
    Then the card shows the title as I typed it, angle brackets and all
    And no image, or anything else from the title, is added to the page

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: The query stays out of the address
    A query can say more about me than a link does, so it is sent in the
    request's body, never in an address that the browser's history or a log
    would keep.

    When I search for "a tool for testing"
    Then the page's address stays the same
    And the query is sent to Haystack in the request's body

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Searching with the keyboard alone
    Focus stays where I searched from, so I can change the query and search
    again straight away. The results come after the field and the button.

    When I press Tab six times
    Then the focus moves through the Haystack wordmark, the links "Search" and "Saved links", the button "Sign out", the field and the button "Search"
    When I press Shift+Tab
    Then the field has focus
    When I type a query and press Enter
    Then the page says how many links match, and the field still has focus
    When I press Tab
    Then the button "Search" has focus
    When I press Tab again
    Then the first result's title has focus

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Pressing the button keeps focus on it
    When I type a query, move to the button "Search" and press Space
    Then the page says how many links match, and the button still has focus

  @voiceover:apps/worker/e2e/search.voiceover.ts
  Scenario: Searching with a screen reader
    Given I use VoiceOver
    And my search finds "Vitest browser mode guide" and "Playwright locators"
    When I move to the field
    Then VoiceOver reads its label, "Search your saved links"
    When I type a query and press Enter
    And I move by heading
    Then VoiceOver reads "Vitest browser mode guide", a link, at level 2
    And the heading after that is "Playwright locators", a link, at level 2

  @untested
  Scenario: Hearing how many links match with a screen reader
    The count is written to a live region, which a screen reader should read
    without the page moving focus. VoiceOver doesn't speak it yet: on CI it
    said only "browser" and the text field's hint, with the count written
    100 ms and then 500 ms after the results. #237 is to make it speak.
    search.voiceover.ts has a test of it marked as failing, which shows the
    problem but doesn't cover this journey.

    Given I use VoiceOver
    And my search finds "Vitest browser mode guide" and "Playwright locators"
    When I type a query in the field and press Enter
    Then VoiceOver says "2 saved links match your search."

  @untested
  Scenario Outline: Hearing that a search is slow, incomplete or failed with a screen reader
    These messages are written to the same live region as the count, while
    focus stays in the field, so VoiceOver is expected not to speak them for
    the same reason, and #237 is to make it speak them too. search.voiceover.ts
    has a test of each marked as failing, which doesn't cover this journey.

    Given I use VoiceOver
    When I type a query in the field and press Enter, and <what happens>
    Then VoiceOver says "<message>"

    Examples:
      | what happens                          | message                                                    |
      | Haystack takes a while to answer      | Searching your saved links. This can take a few seconds.   |
      | some of my links couldn't be searched | Some of your links could not be searched                   |
      | the search fails                      | Something went wrong, so your links could not be searched. |

  @playwright:apps/worker/e2e/search.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario Outline: A search that fails
    Until searching is built (#214), Haystack answers every search with "not
    found", and the page treats that as a failure. The error is in the page's
    one live region, in the alert box of the save form's errors, and it does
    not take focus, so I can go on typing. The browser tests check that the
    results of the search before go only for an answer with an error.

    Given I searched, and the page shows what it found
    When my next search fails because <the reason>
    Then the page shows the error "<message>" with the button "Try again", in place of the results
    And the results of the search before are gone, and the page doesn't say that nothing matched
    And the field still has focus

    Examples:
      | the reason                                    | message                                                               |
      | Haystack answers with an error                | Something went wrong, so your links could not be searched.            |
      | Haystack's answer isn't one the page can read | Something went wrong, so your links could not be searched.            |
      | Haystack can't be reached                     | Haystack could not be reached. Check your connection, then try again. |

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Trying a failed search again
    Try again repeats the search that failed, so it puts that query back in
    the field if I changed it since. Try again goes when the search starts, so
    focus moves to the button "Search", where I would press it.

    Given my search for "testing" failed
    And I have typed something else in the field, without searching for it
    When I press "Try again"
    Then "testing" is searched again, and the field holds "testing"
    And the button "Processing…" has focus

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: A search fails while I am typing
    Given I searched, and while Haystack answers I go on typing in the field
    When the search fails
    Then the field keeps focus, and what I type goes on into the field

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Searching after my session ended
    Trying again would only find me signed out again, so there is no "Try
    again". The tests check the link's address, and that opening the search
    page signed out goes through sign-in and names the search page to return
    to, but no test follows the link through sign-in.

    Given I opened the search page while I was signed in
    And my session has ended since
    When I search
    Then the page says "You are signed out, so your links could not be searched." with the link "Sign in again"
    And the field still has focus
    And the link signs me in and brings me back to the search page

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Searching without JavaScript
    The results are built in the browser, so searching needs JavaScript. The
    message is in the page, and the script hides it, so it is also shown when
    the script is blocked or fails to load, which no test checks.

    Given my browser has JavaScript turned off
    When I open the search page
    Then it says "Searching needs JavaScript, which isn't running in this browser."
    And the link "Go to your saved links" takes me to my saved links
    When I type a query and press Enter
    Then the search page loads again, with no query in its address
