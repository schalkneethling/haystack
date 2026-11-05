Feature: Searching my saved links
  The search page is Haystack's home page, at /. The owner of the collection
  describes what they are looking for in their own words, and the page shows
  the links that match in the same cards as the saved links. It is
  built for the keyboard and for a screen reader: focus stays in the field,
  the count of matches is announced, and each result is a heading.

  Searching is real since Phase 11 (#214): a search asks Jev about my saved
  links and the page shows the answer. Most of the browser tests still answer
  the search with a stubbed answer, because a stub decides the answer and when
  it arrives, which the scenarios about a slow, incomplete or failed search
  need. The scenarios "A search that finds links", "A search that finds
  nothing", "A search that is answered in part" and "A search that cannot be
  answered" are the ones that run through Haystack's own search. The search
  page is behind a switch, the `search-enabled` flag, which the owner turns on
  when search is released (#218). Until then the home page is the saved links,
  and the header has no "Search" link. Every scenario but the first is with
  the switch on, as the browser tests run. Each result can be deleted from its card (#208), through
  the same dialog and confirmation page as on the saved links page, which
  delete.feature describes under "From the search results". The scenarios
  here say what the search page shows afterwards.

  A search waits on the service that judges each link, so it can be slow, and
  it can fail for some of the links or for all of them. The page says while
  it is searching, shows what it found with a notice when some links could not
  be searched, and shows an error with a way to try again when the search
  failed, never an empty list, which would look like nothing matched (#207).

  Following a result is recorded (#215), as a hint of which results helped,
  which the evaluation of the search (Phase 12) can use. Nothing about the
  page changes for me, and a failed record never keeps me from the saved page.

  In a browser with speech recognition, such as Chrome or Safari, I can say
  my query instead of typing it (#216). A button next to the field starts the
  browser's own recognition, and what it heard goes in the field for me to
  check. It never searches on its own: I press Search, as for a typed query.
  A browser without speech recognition shows the plain search. The browser
  tests replace the browser's speech recognition with a stub, because a test
  can't use a microphone, so a real microphone is only checked by hand, in
  Chrome. The page records how a query was entered, spoken or typed, and never
  what was said (#217).

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
      | query   | found     | message                           | cards                         |
      | testing | two links | 2 saved links match your search.  | two cards, in the order found |
      | one     | one link  | 1 saved link matches your search. | one card                      |
      | nothing | no link   | No saved links match your search. | no cards, and no error        |

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-api.test.ts
  Scenario: A search that finds links
    Haystack asks the service that judges each of my links, whether it would
    help with what I described. The links that clear the threshold are shown,
    the best match first. Haystack also keeps, for every link it asked about,
    both of the service's answers, whether or not the link is shown, so that
    the ranking can be judged later. The query is kept with them, and in no
    log.

    Given I have saved several links, and Haystack has described them
    And two of them match what I describe, one better than the other
    When I search for what I describe
    Then the page says "2 saved links match your search."
    And it shows the two cards, the better match first
    And Haystack has kept both answers for every link it asked about, the one that did not match too

  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: A search that finds nothing
    A search that finds nothing is an answer, and not an error.

    Given I have saved links, and none of them matches what I describe
    When I search for what I describe
    Then the page says "No saved links match your search."
    And it shows no cards, and no error

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-api.test.ts
  Scenario: A search that is answered in part
    Haystack asks about my links in several requests when there are many. If
    only some of them are answered, it shows what those found, with the notice
    that there may be more matches, and says so in its log.

    Given I have saved so many links that Haystack asks about them in several requests
    And the service that judges them answers only some of the requests
    When I search
    Then the page shows the cards that the answered requests found
    And the page says "Some of your links could not be searched, so there may be more matches. You can press Search to try again."

  @playwright:apps/worker/e2e/search.e2e.ts
  @integration:apps/worker/test/search-api.test.ts
  Scenario: A search that cannot be answered
    When the service that judges my links answers none of the requests,
    Haystack answers the page with an error. It does not answer with an empty
    list, which would look like nothing matched. The page shows the error with
    "Try again", and trying again searches again once the service is back. The
    search is logged as failed.

    Given the service that judges my links is not answering
    When I search
    Then the page shows the error "Something went wrong, so your links could not be searched." with the button "Try again"
    And it shows no cards, and does not say that nothing matched
    When the service is answering again, and I press "Try again"
    Then the page shows the cards that the search found

  @integration:apps/worker/test/search-api.test.ts
  Scenario: Searching only my own links
    The search reads the links of the person who is signed in, and the person
    comes from the session, never from what the page sends.

    Given another person has saved links of their own
    When I search
    Then the page shows none of their links
    And none of their links is sent to the service that judges them
    And the log of my search holds none of their links

  @integration:apps/worker/test/search-api.test.ts
  @integration:apps/worker/test/search-bookmarks.test.ts
  Scenario: Leaving a search that is still running
    Changing the query while a search runs, giving up on it after 30 seconds or
    leaving the page ends the search I abandoned. It asks the service that
    judges my links about no more of them, because each request costs money,
    and it is still logged, with the reason "aborted", even if the page has
    already gone, because Haystack keeps the search running for the log. A
    request already on its way can't be taken back, so it is finished. If the
    search is still running when the page is gone, Haystack answers 499, a
    closed request, and Cloudflare's metrics count a disconnect as a status of
    their own, so neither is read as an outage of that service.

    Given I started a search that is asking about my links in several requests
    When I change the query, so the page gives up on that search
    Then the search I gave up on sends no more requests
    And it is logged as a search that was cut short

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
    And it shows the error "Searching your saved links took too long." with the button "Try again", in the message bar above the form, in place of the results
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
  @playwright:apps/worker/e2e/search-delete.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario: What a result shows
    design.e2e.ts checks that the Delete buttons of a row of results line up
    at the bottom of their cards.

    The card is the saved links page's card, so the date and the address help
    me tell two similar links apart, for example before I delete one.

    Given my search finds "A guide", saved on 1 October 2026, with the description "First line" and "Second line" on two lines
    When I search
    Then its card shows "Saved October 1, 2026"
    And then the title "A guide" as a heading at level 3, under the heading "Results", which links to the saved page
    And then the address
    And then the description, on two lines
    And at the bottom of the card, the button "Delete"
    And the card is the one my saved links show for the same link
    And the saved site is not told that I came from Haystack, when I follow the link

  @playwright:apps/worker/e2e/search-click.e2e.ts
  @integration:apps/worker/test/search-click.test.ts
  Scenario Outline: Following a result is recorded
    The page tells Haystack which of the search's results I followed, and
    Haystack marks that one link as followed in the log of that search. No
    other link of that search, and no link of another search, is marked, and
    each result is recorded against the search that showed it, so a result of
    an earlier search still counts for that one after I search again. Nothing
    is recorded for a click on the card outside its link, on "Delete", or with
    the right button. Following the same result again leaves it marked as
    followed.

    Given I searched, and the page shows two results
    When I follow the second result by <how>
    Then I reach the saved page, <where>
    And Haystack has marked only the second result of that search as followed

    Examples:
      | how                                              | where                                          |
      | clicking its title                               | in this tab                                    |
      | focusing its title and pressing Enter            | in this tab                                    |
      | clicking its title with the middle button        | in a new tab, and the results stay in this one |
      | clicking its title while holding Ctrl or Command | in a new tab, and the results stay in this one |

  @playwright:apps/worker/e2e/search-click.e2e.ts
  Scenario: Recording a followed result never slows or breaks the visit
    The page sends the record in a way that the browser finishes after the
    page has gone, so I reach the saved page without waiting for it. If the
    record fails, for example because Haystack can't be reached or the browser
    can't send it, nothing is shown and the link still opens.

    Given I searched, and the page shows two results
    And Haystack has not yet received the record of a result I followed
    When I follow the result
    Then I reach the saved page, with no wait for the record
    And the record still arrives afterwards
    When the record fails instead
    Then I still reach the saved page, and the page shows no error

  @playwright:apps/worker/e2e/search-click.e2e.ts
  @playwright:apps/worker/e2e/search.e2e.ts
  Scenario: Following a result changes nothing I can see or reach
    The title is still a link that tells the saved site nothing about where I
    came from, and the card has no new control: Tab reaches only its link and
    its "Delete" button.

    Given I searched, and the page shows two results
    Then each title's link keeps the attribute that keeps the saved site from learning where I came from
    And a card holds only two controls that Tab can reach, its link and its "Delete" button

  @integration:apps/worker/test/search-click.test.ts
  Scenario: Only my own searches can be marked
    The record names a search and a link, and Haystack finds the answer
    through the search and the search through the person who is signed in. A
    search of another person, one that does not exist, a link that was not
    among that search's answers and a link I deleted all get the same answer,
    "not found", and change nothing, so the answer never says that another
    person's search exists. A request without a session is refused, and so is
    one from another site.

    Given another person has searched
    When a request names their search and one of their links
    Then Haystack answers that the answer was not found, and marks nothing
    When a request comes without my session, or from another site
    Then Haystack refuses it, and marks nothing

  @playwright:apps/worker/e2e/search-delete.e2e.ts
  Scenario: Deleting every result of a search
    The message doesn't say that I have saved nothing, because the search
    found only some of my links. The next search's results, or its message
    that nothing matches, replace it.

    Given my search for "guides" finds only "A guide"
    And I searched for "guides"
    When I delete "A guide" from the results
    Then focus moves to the heading "Search your saved links"
    And the page says "You deleted every link this search found. Search again to find others."
    When I search for something else
    Then that message is gone, and the page shows what the new search found

  @playwright:apps/worker/e2e/search-delete.e2e.ts
  Scenario: A new search's results arrive while I am deleting
    The results of a search stay until the next search answers, so I can open
    the dialog for one of them while the next search runs.

    Given I searched for "guides", which found "A guide" and "Another guide"
    And I searched again, for "more guides", and Haystack has not answered yet
    And I opened the dialog for "A guide"
    When the new results arrive, "A guide" and "A third guide"
    And I press "Delete" in the dialog
    Then "A guide" is gone from the new results
    And focus moves to the title of the next result, "A third guide"
    And the status message says "Deleted “A guide”."

  @playwright:apps/worker/e2e/search-delete.e2e.ts
  Scenario: A new search's results arrive after I deleted a result
    The new results replace the title that focus moved to after the delete,
    so focus moves to the button "Search" first, and never falls to the page.
    The new search was answered before the delete, so its results may still
    show the deleted link. Its Delete button then says that the link was
    already deleted.

    Given I searched for "guides", which found "A guide" and "Another guide"
    And I searched again, for "more guides", and Haystack has not answered yet
    And I deleted "A guide" from the results, and focus moved to the title "Another guide"
    When the new results arrive
    Then focus moves to the button "Search"
    And the page says how many links the new search found, in place of "Deleted “A guide”."

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
    again straight away. The results come after the field and the buttons.
    In a browser with speech recognition, the button "Search by voice" is
    between the field and "Search", which the test makes so with the stub.

    Given my browser has speech recognition
    When I press Tab eight times
    Then the focus moves through the Haystack wordmark, the links "Search" and "Saved links", the button "Sign out", the button "Close messages", the field, the button "Search by voice" and the button "Search"
    When I press Shift+Tab twice
    Then the field has focus
    When I type a query and press Enter
    Then the page says how many links match, and the field still has focus
    When I press Tab
    Then the button "Search by voice" has focus
    When I press Tab again
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
    Then VoiceOver reads "Results" as a heading at level 2
    And the heading after that is "Vitest browser mode guide", a link, at level 3
    And the heading after that is "Playwright locators", a link, at level 3

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
    The page shows an error for any answer that isn't a list of results, which
    the tests stub. Of the ways Haystack's own search answers with an error,
    "A search that cannot be answered", where Jev answers nothing, is the only
    one that a valid search can meet because of Jev. The others, a body that is
    refused (400) or too large (413) and a fault of Haystack's own (500), are
    not something the page sends. The error is in the search's live region,
    in the alert box of the save form's errors, and it does not take focus, so
    I can go on typing. The browser tests check that the results of the search
    before go only for an answer with an error.

    Given I searched, and the page shows what it found
    When my next search fails because <the reason>
    Then the page shows the error "<message>" with the button "Try again", in the message bar above the form, in place of the results
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
    focus moves to the button "Search", where I would press it. The browser
    tests try again after an error, a network error and a search that took
    too long, and the search sent again gets 30 seconds of its own.

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
  @playwright:apps/worker/e2e/search-delete.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Searching after my session ended
    Trying again would only find me signed out again, so there is no "Try
    again". The link returns to the search page, also when the page is shown
    at a delete's address, after a delete through the confirmation page. The
    tests check the link's address, and that opening the search page signed
    out goes through sign-in and names the search page to return to, but no
    test follows the link through sign-in.

    Given I opened the search page while I was signed in
    And my session has ended since
    When I search
    Then the page says "You are signed out, so your links could not be searched." with the link "Sign in again"
    And the field still has focus
    And the link signs me in and brings me back to the search page

  @playwright:apps/worker/e2e/search.e2e.ts
  @playwright:apps/worker/e2e/search-voice.e2e.ts
  @integration:apps/worker/test/search-page.test.ts
  Scenario: Searching without JavaScript
    The results are built in the browser, so searching needs JavaScript. The
    message is in the page, and the script hides it, so it is also shown when
    the script is blocked or fails to load, which no test checks.

    Given my browser has JavaScript turned off
    When I open the search page
    Then it says "Searching needs JavaScript, which isn't running in this browser."
    And the link "Go to your saved links" takes me to my saved links
    And there is no button "Search by voice", and no note about it
    When I type a query and press Enter
    Then the search page loads again, with no query in its address

  @playwright:apps/worker/e2e/search-voice.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario: Searching by voice
    The button is added only when my browser has speech recognition, after
    the field and before "Search". It is a toggle, pressed while the browser
    listens, which it shows by turning straw with a stop square in place of
    the microphone. It says it is listening only once the browser does, so not
    while the browser is still asking me for the microphone. The browser
    listens in my browser's language, for one query, and stops when I pause.
    Focus stays on the button, so Tab takes me to "Search".

    Given my browser has speech recognition
    When I open the search page
    Then the button "Search by voice" is next to the field
    And under the field it says "In some browsers, including Chrome, searching by voice sends a recording of what you say to the browser maker's servers, which turn it into text."
    When I press "Search by voice" and the browser starts listening
    Then the button is pressed, and the page says "Listening. Say what you're looking for, then pause."
    When I say "rust error handling" and pause
    Then the field holds "rust error handling", in place of anything I had typed
    And the button is no longer pressed, and the page says "Check what was heard in the field, then press Search."
    And nothing has been searched
    When I press "Search"
    Then "rust error handling" is searched, and the message about what was heard goes
    And the page records that the query was spoken, not what I said

  @playwright:apps/worker/e2e/search-voice.e2e.ts
  Scenario: Stopping or changing what was heard
    Given I pressed "Search by voice" and the browser is listening
    When I press "Search by voice" again
    Then the browser stops listening, and puts what it heard so far in the field
    When I change the text in the field
    Then the message about what was heard goes
    And a search of the changed text is recorded as typed, not as spoken

  @playwright:apps/worker/e2e/search-voice.e2e.ts
  Scenario: Typing or searching while the browser listens
    What I type or search for is mine, so the browser stops listening, and
    anything it would have heard later never replaces it. Before the browser
    starts listening, while it may still be asking me for the microphone,
    pressing "Search by voice" again does nothing: the browser's own prompt
    is where I cancel.

    Given I pressed "Search by voice" and the browser is listening
    When I type in the field, or search for what I typed
    Then the browser stops listening, the button is no longer pressed, and the page says nothing about it
    And the field keeps what I typed, and the results are for it
    And a search for what I typed is recorded as typed

  @playwright:apps/worker/e2e/search-voice.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario Outline: Searching by voice fails
    Each failure ends listening and says why next to the field, in the alert
    box of the page's other errors, and leaves the field as it was. Pressing
    "Search by voice" again listens again. When listening was cancelled, by the
    browser's own controls, nothing is said.

    Given I pressed "Search by voice"
    When <what happens>
    Then the button is no longer pressed
    And the page says "<message>" under the field
    And the field still holds what I had typed

    Examples:
      | what happens                                            | message                                                                                       |
      | I don't allow the browser to use the microphone         | This browser isn't allowing Haystack to use the microphone. You can type your search instead. |
      | I say nothing                                           | No speech was recognized. You can try again, or type your search.                             |
      | the browser recognizes none of what I said              | No speech was recognized. You can try again, or type your search.                             |
      | the browser can't reach its recognition service         | Speech recognition couldn't reach its service. Check your connection, or type your search.    |
      | the browser fails in another way, such as no microphone | Searching by voice isn't working in this browser right now. You can type your search instead. |

  @playwright:apps/worker/e2e/search-voice.e2e.ts
  Scenario: A browser without speech recognition
    Given my browser has no speech recognition
    When I open the search page
    Then it is the plain search, with the field and the button "Search"
    And there is no button "Search by voice", no disabled control and no message about it

  @voiceover:apps/worker/e2e/search-voice.voiceover.ts
  Scenario: Reaching the voice button with a screen reader
    The test stubs the browser's speech recognition, because a test can't use
    a microphone.

    Given I use VoiceOver
    When I move with Tab from the field to the button
    Then VoiceOver reads its name, "Search by voice"
    When I press it and the browser starts listening
    Then VoiceOver still reads its name, "Search by voice"

  @untested
  Scenario: Hearing that the browser listens, and why it stopped, with a screen reader
    The messages are written to the voice button's own live region while
    focus stays on the button. VoiceOver doesn't speak them yet: on CI it said
    only the button's hint, "You are currently on a toggle button", after the
    press (#275). search-voice.voiceover.ts has a test of each marked as
    failing, which shows the problem but doesn't cover this journey.

    Given I use VoiceOver
    And I have moved with Tab from the field to the button "Search by voice"
    When I press it and the browser starts listening
    Then VoiceOver says "Listening"
    When I say nothing
    Then VoiceOver says "No speech was recognized"

  @untested
  Scenario: Searching by voice with a real microphone in Chrome
    No automated test uses a real microphone or Chrome's recognition service.
    The manual check in the plan, under "Search page", "Voice", covers it.

    Given I use Chrome with a microphone
    When I press "Search by voice", allow the microphone, and say a query
    Then the field holds what I said, and nothing is searched
    When I press "Search"
    Then the page shows what matches
