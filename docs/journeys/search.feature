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
  browser tests run. How a slow search looks, and a search whose results may be
  incomplete, come with #207, and deleting a link from the results with #208.

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
    reader announces (see "Searching with a screen reader").

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
  Scenario: Searching again before the first answer arrives
    Given I searched for "first", and Haystack has not answered yet
    When I search for "second"
    And Haystack answers "second", and then, late, "first"
    Then the page shows only what "second" found, and says how many that is
    And the answer to "first" changes nothing

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
    The count is written to a live region, which VoiceOver reads without the
    page moving focus.

    Given I use VoiceOver
    And my search finds "Vitest browser mode guide" and "Playwright locators"
    When I move to the field
    Then VoiceOver reads its label, "Search your saved links"
    When I type a query and press Enter
    Then VoiceOver says "2 saved links match your search."
    When I move by heading
    Then VoiceOver reads "Vitest browser mode guide", a link, at level 2
    And the heading after that is "Playwright locators", a link, at level 2

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: A search that fails
    Until searching is built (#214), Haystack answers every search with "not
    found", and the page treats that as a failure, as it does a network error.

    Given I searched, and the page shows what it found
    When my next search fails
    Then the page says "Something went wrong, so your links could not be searched. You can press Search to try again."
    And the results of the search before are gone
    And the field still has focus

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Searching after my session ended
    The tests check the link's address, and that opening the search page
    signed out goes through sign-in and names the search page to return to,
    but no test follows the link through sign-in.

    Given I opened the search page while I was signed in
    And my session has ended since
    When I search
    Then the page says "You are signed out, so your links could not be searched." with the link "Sign in again"
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
