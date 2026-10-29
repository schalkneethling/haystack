Feature: Signing in and out
  Haystack is invite-only, so every page except the sign-in pages asks the
  person to sign in with Google first. These journeys are for the owner of the
  collection, who signs in with an allowed Google account, and for anyone who
  reaches Haystack with an account that is not allowed. Signing in should bring
  the person back to what they were doing, and every way it can fail should say
  what happened and what to do next.

  The sign-in outcome pages are reached only through Google's callback, which
  the browser tests cannot complete without the network, so the integration
  tests cover them.

  @integration:apps/worker/test/auth.test.ts
  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/search-page.test.ts
  @integration:apps/worker/test/search-switch.test.ts
  Scenario: Signing in with an allowed Google account
    The sign-in tests follow the sign-in itself to the home page. Which page
    the home page is, with search switched on and off, is checked by
    search-page.test.ts and search-switch.test.ts with a seeded session,
    without signing in.

    Given I am not signed in to Haystack
    When I open Haystack
    Then I am sent to Google to sign in
    When I sign in with a Google account that Haystack allows
    Then I land on Haystack's home page: the search page, under the heading "Search your saved links", or my saved links while search is switched off
    And I stay signed in on this browser for 30 days

  @integration:apps/worker/test/auth.test.ts
  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/recent-saves.test.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario Outline: Coming back to the page I started on after signing in
    Given I am not signed in to Haystack
    When I open <the page I started on>
    And I sign in with a Google account that Haystack allows
    Then I land on <where I land>

    Examples:
      | the page I started on           | where I land                                           |
      | the search page                 | the search page                                        |
      | my saved links                  | my saved links                                         |
      | a save link from the extension  | the save form for that page, filled in as the link was |
      | the "Save a link" page at /save | the "Save a link" address form                         |

  @integration:apps/worker/test/sign-in.test.ts
  Scenario: A sign-in link that points away from Haystack lands on Haystack's home page
    A sign-in link can name the page to return to. Haystack returns only to its
    own pages, so a link that names another site cannot send me there.

    Given I am not signed in to Haystack
    And someone gave me a Haystack sign-in link that names another site as the page to return to
    When I sign in through that link with a Google account that Haystack allows
    Then I land on Haystack's home page, not on the other site

  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/address-form.test.ts
  Scenario: A save link that carries a secret is refused before I sign in
    Haystack never stores an address that carries a secret, not even for the
    moment it takes to sign in, so it refuses the link before sending me to
    Google.

    Given I am not signed in to Haystack
    When I open a save link whose address contains an access token
    Then I am not sent to Google
    And I see the "Save a link" address form with the error "This link contains an access token, key, or password, so it could let anyone who has it act as you."
    And the address field is empty, and the link appears nowhere on the page
    And the header shows only the Haystack wordmark

  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/save-form.test.ts
  @integration:apps/worker/test/save-post.test.ts
  Scenario: A save link for a page that declared a private address keeps that fact through sign-in
    The address itself is never kept. What the link carries is the fact that
    the page declared one, so the save form after sign-in records it, as it
    would have without the detour. The tests check it in parts: the stored
    return page and the form after sign-in in one, and what Save stores for
    that form in another.

    Given I am not signed in to Haystack
    When I open a save link for a page that declared a canonical address containing an access token
    Then I am sent to Google, and the stored return page does not contain the access token
    When I sign in with a Google account that Haystack allows
    Then I land on the save form for the page
    And Haystack records, when I press Save, that the page declared an address with a secret

  @integration:apps/worker/test/sign-in.test.ts
  Scenario: A hand-built sign-in link to a save link with a secret lands on my saved links
    Given I am not signed in to Haystack
    And someone gave me a Haystack sign-in link whose page to return to is a save link with an access token in its address
    When I sign in through that link with a Google account that Haystack allows
    Then I land on my saved links
    And the save link was never stored

  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/pages.test.ts
  Scenario: Signing in with a Google account that is not allowed
    Given I am not signed in to Haystack
    When I sign in with a Google account that Haystack does not allow
    Then I see the page titled "Account not allowed - Haystack"
    And its heading says "This Google account is not allowed to use Haystack"
    And it says "Haystack is invite-only. Sign in with an account that has access."
    And the page does not show my email address
    And I am not signed in
    When I follow the link "Sign in with a different account"
    Then Google asks me which account to use

  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/pages.test.ts
  Scenario Outline: A sign-in link that has expired
    A sign-in link works once, for 10 minutes, and only in the browser where
    signing in started, so a sign-in that was taken elsewhere cannot finish
    in my browser.

    Given I started signing in to Haystack
    When <what happened>
    Then I see the page titled "Sign-in link expired - Haystack"
    And its heading says "This sign-in link has expired"
    And it says "A sign-in link works once, for 10 minutes, and only in the browser where you started signing in."
    And I am not signed in
    When I follow the link "Sign in again"
    Then I am sent to Google to sign in

    Examples:
      | what happened                                                        |
      | I come back from Google more than 10 minutes later                   |
      | I open Google's link back to Haystack a second time                  |
      | I open Google's link back to Haystack in another browser             |
      | I started signing in again in another tab, then finish the first tab |

  @integration:apps/worker/test/sign-in.test.ts
  @integration:apps/worker/test/pages.test.ts
  Scenario: Google cannot confirm my sign-in
    Given I started signing in to Haystack
    When Google sends me back, but Haystack cannot confirm the sign-in with Google
    Then I see the page titled "Sign-in failed - Haystack"
    And its heading says "Sign-in failed"
    And it says "Google could not confirm your sign-in."
    And I am not signed in
    And I can follow the link "Sign in again"

  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/auth.test.ts
  Scenario: Signing out
    Sign out is an ordinary form button, so it works in a browser that has
    JavaScript turned off too. The browser test signs out without JavaScript.

    Given I am signed in to Haystack
    When I press "Sign out" in the page's header
    Then I see the page titled "Signed out - Haystack"
    And its heading says "You are signed out of Haystack"
    And the header shows only the Haystack wordmark
    When I open my saved links again
    Then I am sent to Google to sign in

  @playwright:apps/worker/e2e/smoke.e2e.ts
  Scenario: Signing in again from the signed-out page with the keyboard
    Given I am on the signed-out page
    When I press Tab
    Then the Haystack wordmark has focus
    When I press Tab again
    Then the link "Sign in again" has focus
    When I press Enter
    Then I am sent to Google to sign in

  @integration:apps/worker/test/auth.test.ts
  Scenario: Using Haystack keeps me signed in
    A session lasts 30 days. Using Haystack in the second half of that time
    starts the 30 days again, so a person who uses it at least once every 15
    days stays signed in.

    Given I signed in to Haystack 20 days ago
    When I open my saved links
    Then I stay signed in for another 30 days from now

  @integration:apps/worker/test/auth.test.ts
  Scenario Outline: My session has ended
    The integration tests check both reasons differently. For an expired
    session, they check that a page request is sent to sign in. For an
    account removed from the allowed list, they check that the session is
    removed and that a request to Haystack is refused, using a request that
    is not for a page, so the redirect for a page is checked only in the
    expired case.

    Given I signed in to Haystack earlier
    And <why the session ended>
    When I open my saved links
    Then I am sent to Google to sign in
    And Haystack forgets the old session

    Examples:
      | why the session ended                                   |
      | it is more than 30 days since I last renewed my session |
      | the owner has removed my account from the allowed list  |
