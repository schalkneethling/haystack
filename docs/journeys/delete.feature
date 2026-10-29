Feature: Deleting a saved link
  The owner of the collection can delete a link they saved by mistake, from
  its card on the saved links page, or from a search result (#208). Deleting
  is permanent, so Haystack always asks first. With JavaScript, it asks in a
  dialog and removes the card in place. Without JavaScript, the Delete button
  leads to a confirmation page. Either way, a screen reader user hears which
  link they are about to delete, and what happened afterwards. The rule "From
  the search results" says how deleting from a result differs, and
  search.feature says what the search page shows afterwards.

  Background:
    Given I am signed in to Haystack
    And my saved links include "A guide"

  Rule: With JavaScript, Haystack asks in a dialog

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    @voiceover:apps/worker/e2e/delete-dialog.voiceover.ts
    Scenario: Opening the dialog
      The dialog itself takes focus, so a screen reader announces it before any
      of its buttons. The link's title is part of the dialog's name, because
      VoiceOver reads a dialog's name when it takes focus, but not its
      description.

      When I press the button "Delete A guide"
      Then a dialog opens with the heading "Delete this link?", the title "A guide" and "Deleting is permanent. You can save the link again later."
      And the dialog has focus, and the rest of the page can't be used
      And a screen reader announces the dialog as "Delete this link? A guide" before any of its buttons

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    @voiceover:apps/worker/e2e/delete-dialog.voiceover.ts
    Scenario: Moving through the dialog with the keyboard
      Given I opened the dialog for "A guide" by pressing Enter on its Delete button
      When I press Enter again
      Then nothing is deleted, and the dialog stays open
      When I press Tab
      Then the button "Cancel" has focus
      When I press Tab again
      Then the button "Delete" has focus

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    Scenario: Each dialog names its own link
      Given my saved links also include "Another guide"
      When I open the dialog for "A guide", then cancel it
      And I open the dialog for "Another guide"
      Then the dialog is named "Delete this link? Another guide"

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    @voiceover:apps/worker/e2e/delete-dialog.voiceover.ts
    Scenario Outline: Deleting a link, and where focus goes next
      The message is written half a second after the dialog closes and focus
      moves, because VoiceOver did not speak a message written sooner on this
      page.

      Given my saved links are <the list>, newest first
      When I open the dialog for "<the link>" and press "Delete"
      Then the dialog closes, and the card for "<the link>" is gone
      And focus moves to <where focus goes>
      And half a second later the status message "Deleted “<the link>”." appears, and a screen reader announces it
      And the page did not reload

      Examples:
        | the list                      | the link | where focus goes                                                |
        | "Newest", "A guide", "Oldest" | A guide  | the title of the next card, "Oldest"                            |
        | "Newest", "A guide", "Oldest" | Oldest   | the title of the card before it, "A guide"                      |
        | only "A guide"                | A guide  | the heading "Saved links", and the empty list's message appears |

    @untested
    Scenario: Deleting every link the list shows, when I have older ones
      No test deletes every card on a page of 50. The integration test in
      apps/worker/test/recent-saves.test.ts checks only that the message is
      in the page's markup, hidden, when there are more links than the list
      shows.

      Given I have more saved links than the 50 the list shows
      When I delete every card on the page
      Then the page says "You deleted every link shown here. Reload the page to see your older links."

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    @voiceover:apps/worker/e2e/delete-dialog.voiceover.ts
    Scenario Outline: Changing my mind
      When I open the dialog for "A guide"
      And I <close it>
      Then the dialog closes, and nothing is deleted
      And focus is back on the button "Delete A guide"

      Examples:
        | close it       |
        | press Escape   |
        | press "Cancel" |

    @voiceover:apps/worker/e2e/delete-dialog.voiceover.ts
    Scenario: A screen reader user hears where Escape returns to
      Given I use VoiceOver
      And I opened the dialog for "A guide"
      When I press Escape
      Then VoiceOver reads the button "Delete A guide"

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    Scenario: The dialog can't be closed while the link is being deleted
      Closing the dialog then could look as if it stopped a delete that
      Haystack goes on to make, so Cancel and Escape do nothing until it is
      done.

      Given I pressed "Delete" in the dialog for "A guide", and Haystack has not answered yet
      When I press Escape, or press "Cancel"
      Then the dialog stays open
      When Haystack answers
      Then the dialog closes, and "Deleted “A guide”." appears

    @untested
    Scenario: A screen reader user hears that the dialog's buttons are busy
      While the delete runs, the buttons are marked as unavailable but keep
      focus. The plan records that VoiceOver then reads the Delete button as
      "dimmed", but no test checks it.

      Given I use VoiceOver
      And I pressed "Delete" in the dialog for "A guide", and Haystack has not answered yet
      When I move to the button "Delete"
      Then VoiceOver reads it as dimmed

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    @playwright:apps/worker/e2e/search-delete.e2e.ts
    Scenario: Coming back to the page just after deleting a link
      A browser can keep a page I leave, and show it again as I left it when
      I come back. A message still waiting to be written belongs to the moment
      I left, so it is dropped. The tests send the event a browser sends for a
      restored page, on the saved links page and on the search page.

      Given I pressed "Delete" in the dialog for "A guide", and the card is gone
      When I leave the page within half a second, and come back to it as I left it
      Then the status message "Deleted “A guide”." doesn't appear

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    Scenario: A link that was already deleted somewhere else
      Given I opened the dialog for "A guide"
      And I deleted "A guide" in another tab meanwhile
      When I press "Delete" in the dialog
      Then the card for "A guide" is gone
      And the status message says "“A guide” was already deleted."

    @playwright:apps/worker/e2e/delete-dialog.e2e.ts
    Scenario Outline: The delete fails
      The card stays, and focus goes back to its Delete button, so I can try
      again from where I was.

      Given I opened the dialog for "A guide"
      And <what goes wrong>
      When I press "Delete" in the dialog
      Then the dialog closes, and the card for "A guide" is still there
      And focus is back on the button "Delete A guide"
      And half a second later the status message says "<the message>"

      Examples:
        | what goes wrong                | the message                                                                               |
        | my session has ended           | Could not delete “A guide”, because you are signed out. Reload the page to sign in again. |
        | Haystack answers with an error | Could not delete “A guide”. Reload the page and try again.                                |

    @untested
    Scenario: The delete fails because Haystack can't be reached
      Given I opened the dialog for "A guide"
      And my connection to Haystack fails
      When I press "Delete" in the dialog
      Then the dialog closes, and the card for "A guide" is still there
      And focus is back on the button "Delete A guide"
      And half a second later the status message says "Could not delete “A guide”. Check your connection and try again."

  Rule: Without JavaScript, Haystack asks on a page of its own

    @playwright:apps/worker/e2e/delete.e2e.ts
    @integration:apps/worker/test/delete-bookmark.test.ts
    Scenario: Deleting a link through the confirmation page
      A screen reader announces a page's title when the page loads, but not a
      status message that arrives with it, so the title says what was deleted.

      Given my browser has JavaScript turned off
      When I press the button "Delete A guide"
      Then I see the page titled "Delete this link? - Haystack", under the heading "Delete this link?"
      And it shows "Title: A guide", the link's address, and "Deleting is permanent. You can save the link again later."
      When I press "Delete"
      Then I am back on my saved links, and the card for "A guide" is gone
      And the page's title is "Deleted “A guide” - Saved links - Haystack"
      And the status message says "Deleted “A guide”."
      And the page starts from the top, as any page that loads does

    @playwright:apps/worker/e2e/delete.e2e.ts
    Scenario: Keeping the link
      Given my browser has JavaScript turned off
      And I pressed the button "Delete A guide"
      When I follow the link "Keep it and go back to your saved links"
      Then I am back on my saved links, at the card for "A guide"
      And nothing is deleted

    @integration:apps/worker/test/delete-bookmark.test.ts
    Scenario Outline: A link that is no longer in my saved links
      Given my browser has JavaScript turned off
      And <what happened>
      Then I see the page titled "Link not found - Haystack"
      And its heading says "This link isn't in your saved links"
      And it says "It may have been deleted already."
      And the link "Go to your saved links" takes me back to my saved links

      Examples:
        | what happened                                                                               |
        | I deleted "A guide", and then reloaded the page and let the browser send the form again     |
        | I opened the confirmation page, deleted "A guide" in another tab, and then pressed "Delete" |

  Rule: From the search results, the same dialog and confirmation page are used

    @playwright:apps/worker/e2e/search-delete.e2e.ts
    Scenario: Each result's Delete button names its link
      Given search is switched on
      And my search for "guides" finds "A guide" and "Another guide"
      When I search for "guides"
      Then each result has a button "Delete", named "Delete A guide" and "Delete Another guide"

    @playwright:apps/worker/e2e/search-delete.e2e.ts
    Scenario: Opening and closing the dialog from a result with the keyboard
      Given search is switched on
      And I searched for "guides", which found "A guide"
      When I press Tab until the button "Delete A guide" has focus, and press Enter
      Then the dialog "Delete this link? A guide" opens, and has focus
      When I press Tab
      Then the button "Cancel" has focus
      When I press Escape
      Then the dialog closes, nothing is deleted, and focus is back on the button "Delete A guide"

    @playwright:apps/worker/e2e/search-delete.e2e.ts
    Scenario Outline: Deleting a result, and where focus goes next
      The message is written half a second after the dialog closes and focus
      moves, as on the saved links page. It replaces the count, which is not
      said again.

      Given search is switched on
      And I searched for "guides", which found <the results>, in that order
      When I open the dialog for "<the link>" and press "Delete"
      Then the dialog closes, and the result "<the link>" is gone
      And focus moves to <where focus goes>
      And half a second later the status message "Deleted “<the link>”." appears, in place of the count
      And the page did not reload

      Examples:
        | the results                            | the link   | where focus goes                                                                                                                        |
        | "First guide", "A guide", "Last guide" | A guide    | the title of the next result, "Last guide"                                                                                              |
        | "First guide", "A guide", "Last guide" | Last guide | the title of the result before it, "A guide"                                                                                            |
        | only "A guide"                         | A guide    | the heading "Search your saved links", and the message "You deleted every link this search found. Search again to find others." appears |

    @voiceover:apps/worker/e2e/search-delete.voiceover.ts
    Scenario: A screen reader user deletes a link from the results
      The status message is written after focus has moved, as on the saved
      links page. That is not the case of the search's count, which VoiceOver
      doesn't speak yet because focus stays in the field (#237), so the test
      searches before VoiceOver reads the page.

      Given search is switched on
      And I use VoiceOver
      And I searched for "guides", which found "A guide"
      When I press Enter on the button "Delete A guide"
      Then VoiceOver announces the dialog as "Delete this link? A guide" before any of its buttons
      When I press Escape
      Then VoiceOver reads the button "Delete A guide"
      When I open the dialog again and press "Delete"
      Then VoiceOver says "Deleted “A guide”."

    @playwright:apps/worker/e2e/search-delete.e2e.ts
    @integration:apps/worker/test/search-page.test.ts
    Scenario: Deleting a result through the confirmation page
      The search page builds its results in the browser, so a result's Delete
      button always has the page's script behind it, and the confirmation page
      is for a browser that can't show the dialog. The browser test skips the
      dialog as such a browser does. The results exist only in the page that
      searched, and showing them again would mean searching again, so
      confirming returns to the search page without results.

      Given search is switched on
      And my browser can't show the dialog
      And I searched for "guides", which found "A guide"
      When I press the button "Delete A guide"
      Then I see the page titled "Delete this link? - Haystack", with "Title: A guide" and the link's address
      When I press "Delete"
      Then I am back on the search page, with no results
      And the page's title is "Deleted “A guide” - Search - Haystack"
      And the status message says "Deleted “A guide”."
      And the page starts from the top, as any page that loads does

    @playwright:apps/worker/e2e/search-delete.e2e.ts
    @integration:apps/worker/test/search-page.test.ts
    Scenario: Keeping a link from the results
      Given search is switched on
      And my browser can't show the dialog
      And I pressed the button "Delete A guide" in the results
      When I follow the link "Keep it and go back to search"
      Then I am back on the search page
      And nothing is deleted

    @integration:apps/worker/test/search-page.test.ts
    @integration:apps/worker/test/delete-bookmark.test.ts
    Scenario Outline: Where the confirmation page returns to
      The tests check where sign-in is told to return to, but none follows it
      through sign-in.

      Given search is switched on
      And my browser can't show the dialog
      And I pressed the button "Delete A guide" in the results
      When <what happens>
      Then <where I land>

      Examples:
        | what happens                                                       | where I land                                                           |
        | I press "Delete", and then reload the page and send the form again | the page "This link isn't in your saved links"                         |
        | the owner switched search off, and then I press "Delete"           | my saved links, saying "Deleted “A guide”."                            |
        | my session ended, and then I press "Delete"                        | sign-in, which brings me back to the search page, with nothing deleted |

  Rule: A deleted link can be saved again

    @integration:apps/worker/test/delete-bookmark.test.ts
    Scenario: Saving a link again after deleting it
      Given I deleted "A guide"
      When I save its address again
      Then I see the heading "Saved", not "You already saved this link"
