Feature: The saved links list
  The saved links page, at /saved-links, shows the owner's most recent links,
  newest first, as cards, with the "Save a link" form above them. Each card
  links to the page it saved, and has a Delete button. The list is plain HTML,
  so it works without JavaScript, and a screen reader user can move through it
  by heading. It was Haystack's home page in Milestone 1, and moved to a page
  of its own so that the search page can take the home page (#205).

  Background:
    Given I am signed in to Haystack

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: Haystack's home page sends me on to my saved links
    Until the search page takes the home page, the home page sends me on to
    the saved links page. The integration test checks the redirect.

    When I open Haystack's home page
    Then I land on my saved links, at /saved-links

  @playwright:apps/worker/e2e/recent-saves.e2e.ts
  @playwright:apps/worker/e2e/design.e2e.ts
  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: An empty list
    Given I have not saved any links
    When I open my saved links
    Then I see the page titled "Saved links - Haystack", under the heading "Saved links"
    And it says "You haven't saved any links yet. Links you save appear here, newest first."
    And the "Save a link" form is at the top of the page

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: The notice about private links
    When I open my saved links
    Then the page shows the notice "Do not save links that contain access tokens, private shares, or sign-in and password reset links. Saved links are sent to the services that describe them, so a private link would no longer be private."
    And the notice is part of the page, with nothing to dismiss

  @playwright:apps/worker/e2e/recent-saves.e2e.ts
  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: The newest link comes first
    Given I saved "First guide", and then "Second guide"
    When I follow the link "See it in your saved links" after saving "Second guide"
    Then "Second guide" is the first card on my saved links, and "First guide" is the second
    And this works without JavaScript too

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: What a card shows
    Given I saved "https://example.com/guide?page=2" with the title "A guide" and the description "How to do the thing." on 13 October 2026
    When I open my saved links
    Then its card shows, in this order, "Saved October 13, 2026", the title "A guide" as a link to the page, the address and the description
    And the card has a button "Delete"

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: The date a link was saved is in UTC
    Haystack's server does not know the reader's time zone, so it writes the
    date in UTC.

    Given I saved a link at 23:30 UTC on 13 October 2026
    When I open my saved links
    Then its card says "Saved October 13, 2026", whatever my own time zone is

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: A description with line breaks
    Given I saved a link whose description has two lines
    When I open my saved links
    Then its card shows the description on two lines

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: Opening a saved page
    When I follow a card's title on my saved links
    Then the browser opens the saved page
    And the saved site is not told that I came from Haystack

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: More links than the list shows
    The list shows the 50 most recent links.

    Given I have saved 51 links
    When I open my saved links
    Then I see the 50 most recent, newest first
    And the list starts with the note "This list shows only your 50 most recent links."

  @integration:apps/worker/test/recent-saves.test.ts
  Scenario: Exactly as many links as the list shows
    Given I have saved 50 links
    When I open my saved links
    Then I see all 50, and no note about the limit

  @voiceover:apps/worker/e2e/recent-saves.voiceover.ts
  Scenario: Moving through the list with a screen reader
    Given I use VoiceOver
    And I saved "Older guide", and then "Newer guide"
    When I open my saved links and move by heading
    Then VoiceOver reads "Saved links" as a heading at level 1
    And the next heading is "Newer guide", a link, at level 2
    And the heading after that is "Older guide", a link, at level 2

  @integration:apps/worker/test/delete-bookmark.test.ts
  @playwright:apps/worker/e2e/delete-dialog.e2e.ts
  Scenario: Telling the Delete buttons apart with a screen reader
    Each button shows "Delete", and its name for a screen reader adds the
    link's title, so a list of buttons says which one deletes which link.

    Given I saved "A guide"
    When I open my saved links
    Then the card's button reads "Delete" on the screen
    And a screen reader names it "Delete A guide"

  @playwright:apps/worker/e2e/design.e2e.ts
  Scenario: The current page in the header
    When I open my saved links
    Then the header's link "Saved links" is marked as the current page
    When I open the save form for a link
    Then the header's link "Saved links" is no longer marked as the current page
