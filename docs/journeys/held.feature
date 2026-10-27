Feature: Reviewing links that Haystack held back or couldn't describe
  Haystack describes each saved link with the help of other services. Two
  kinds of link need their owner before that can happen. A link that looks as
  if it might give access to something private is held back, and nothing
  about it is sent anywhere until its owner releases it. A link that Haystack
  tried to describe several times and couldn't is left alone until its owner
  asks it to try again. The page "Links to review", at /held, lists both
  kinds, and lets the owner release, retry or delete each one. It works
  without JavaScript, and a screen reader user hears the result of each
  action.

  Background:
    Given I am signed in to Haystack

  Rule: The page shows only what needs me

    @playwright:apps/worker/e2e/design.e2e.ts
    @integration:apps/worker/test/held.test.ts
    Scenario: Nothing to review
      Given none of my links is held back, and Haystack has described or is still describing every one of them
      When I open /held
      Then I see the page titled "Links to review - Haystack", under the heading "Links to review"
      And it says "Nothing to review. Links that Haystack holds back because they might be private, and links it couldn't describe, appear here."
      And the link "Go to your saved links" takes me back to my saved links

    @playwright:apps/worker/e2e/held.e2e.ts
    @integration:apps/worker/test/held.test.ts
    Scenario: Finding the page from my saved links
      The saved links page shows the link only when something waits on /held.

      Given Haystack held back one of my links, and couldn't describe two others
      When I open my saved links
      Then the page says "Review 3 links that Haystack held back or couldn't describe."
      When I follow the link "Review 3 links"
      Then I see the heading "Links to review"

    @integration:apps/worker/test/held.test.ts
    Scenario: Only my own links are listed
      Given another person's links include one that Haystack held back
      When I open /held
      Then I don't see their link
      And my saved links don't offer a link to /held for it

    @integration:apps/worker/test/held.test.ts
    Scenario: What a held-back link's card shows
      The card shows the link's host, not its whole address, because the rest
      of the address may be what makes it private.

      Given Haystack held back "A shared folder", saved from "https://drive.example.com/share/9f8e7d6c?key=s3cret"
      When I open /held
      Then the card is under the heading "Held back"
      And it shows the date I saved it, the title "A shared folder" and "drive.example.com"
      And it has the checkbox "This link does not give access to anything private", and the buttons "Release" and "Delete"

    @integration:apps/worker/test/held.test.ts
    Scenario: What a card for a link Haystack couldn't describe shows
      The last error is in plain words, chosen from what Haystack was doing
      and why it failed. The error that Haystack stored is never shown.

      Given Haystack couldn't describe "A guide", because the service it asked took too long to answer
      When I open /held
      Then the card is under the heading "Not described"
      And it shows the date I saved it, the title "A guide" and its host
      And it says "Last error: Writing its description failed, because the service took too long to answer."
      And it has the buttons "Retry" and "Delete"

  Rule: Releasing a held-back link

    @playwright:apps/worker/e2e/held.e2e.ts
    @voiceover:apps/worker/e2e/held.voiceover.ts
    @integration:apps/worker/test/held.test.ts
    Scenario Outline: Releasing a link, <with or without> JavaScript
      Release is an ordinary form either way, so the page loads again. Its
      result takes focus, so a screen reader reads it, and Tab goes on to the
      links that are left. The VoiceOver test runs with JavaScript turned on.

      Given my browser has JavaScript <turned on or off>
      And Haystack held back "A guide"
      When I tick "This link does not give access to anything private" on its card
      And I press "Release A guide"
      Then the page's title is "Released “A guide” - Links to review - Haystack"
      And the status message "Released “A guide”. Haystack can now describe it." has focus
      And a screen reader announces it
      And the card for "A guide" is gone, because Haystack can now describe the link

      Examples:
        | with or without | turned on or off |
        | with            | turned on        |
        | without         | turned off       |

    @integration:apps/worker/test/held.test.ts
    Scenario: Releasing a link that Haystack had already failed to describe
      A link can be held back after Haystack tried to describe it several
      times, for example when the threshold for private links is lowered.
      Once released, it is one that Haystack couldn't describe, so it moves to
      the other list, where Retry brings it back.

      Given Haystack held back "A guide", and had already stopped trying to describe it
      When I tick "This link does not give access to anything private" on its card
      And I press "Release A guide"
      Then the page's title is "Released “A guide” - Links to review - Haystack"
      And the status message "Released “A guide”. Haystack couldn't describe it before, so it's now under “Not described”, where you can retry it." has focus
      And the card for "A guide" is under the heading "Not described", with the button "Retry"

    @playwright:apps/worker/e2e/held.e2e.ts
    Scenario: Pressing Release without ticking the box
      Given Haystack held back "A guide"
      When I press "Release A guide" without ticking its checkbox
      Then my browser asks me to tick the checkbox
      And nothing is sent, and the link stays held back

    @integration:apps/worker/test/held.test.ts
    Scenario: A release that arrives without the box ticked
      Only a browser that skips the checkbox's check, or a request built by
      hand, gets here.

      Given Haystack held back "A guide"
      When a release of "A guide" arrives without the checkbox
      Then the page's title is "Not released “A guide” - Links to review - Haystack"
      And the status message says "“A guide” was not released. Tick “This link does not give access to anything private” to release it."
      And the link stays held back

    @integration:apps/worker/test/held.test.ts
    Scenario: Releasing a link again, for example in a second tab
      Given I released "A guide" in another tab
      When I press "Release A guide" on this page, with its box ticked
      Then the status message says "Released “A guide”. Haystack can now describe it."
      And the time I first released it is kept

    @integration:apps/worker/test/held.test.ts
    Scenario: Releasing a link that isn't held back
      A link is released only while it is held back, so a release always means
      that I saw it held back. A link that was never checked can't be released
      ahead of the check, because the release would let it skip the check. The
      integration test sends the request by hand, because /held shows no
      Release button for such a link.

      Given "A guide" isn't held back, for example because the threshold for private links was raised after the page loaded
      When a release of "A guide" arrives, with the box ticked
      Then the page's title is "Nothing to release for “A guide” - Links to review - Haystack"
      And the status message says "“A guide” isn't held back, so there was nothing to release."
      And nothing changes in Haystack

  Rule: Retrying a link Haystack couldn't describe

    @playwright:apps/worker/e2e/held.e2e.ts
    @voiceover:apps/worker/e2e/held.voiceover.ts
    @integration:apps/worker/test/held.test.ts
    Scenario Outline: Retrying a link, <with or without> JavaScript
      Retry is an ordinary form either way, so the page loads again, and its
      result takes focus. The VoiceOver test runs with JavaScript turned on.

      Given my browser has JavaScript <turned on or off>
      And Haystack couldn't describe "A guide"
      When I press "Retry A guide"
      Then the page's title is "Retrying “A guide” - Links to review - Haystack"
      And the status message "Retrying “A guide”. Haystack will try to describe it again soon." has focus
      And a screen reader announces it
      And the card for "A guide" is gone, because Haystack will try it again in its next run

      Examples:
        | with or without | turned on or off |
        | with            | turned on        |
        | without         | turned off       |

    @integration:apps/worker/test/held.test.ts
    Scenario: Retrying a link again, for example in a second tab
      Given I retried "A guide" in another tab
      When I press "Retry A guide" on this page
      Then the status message says "Retrying “A guide”. Haystack will try to describe it again soon."

    @integration:apps/worker/test/held.test.ts
    Scenario: Retrying a link that Haystack is still trying to describe
      Retry is only for a link that Haystack stopped trying to describe, so it
      can't move a link that Haystack is still trying ahead of the others. The
      integration test sends the request by hand.

      Given Haystack failed to describe "A guide", but hasn't stopped trying
      When a retry of "A guide" arrives
      Then the page's title is "Nothing to retry for “A guide” - Links to review - Haystack"
      And the status message says "“A guide” isn't waiting for a retry."
      And nothing changes in Haystack

  Rule: Deleting a link from /held

    @playwright:apps/worker/e2e/held.e2e.ts
    Scenario Outline: Deleting with JavaScript, and where focus goes next
      The delete dialog works here as on the saved links page (see
      delete.feature). When the last card of a kind is deleted, its heading
      goes too.

      Given <the links on /held>
      When I open the dialog for "<the link>" and press "Delete"
      Then the dialog closes, and the card for "<the link>" is gone
      And focus moves to <where focus goes>
      And the status message "Deleted “<the link>”." appears
      And the page did not reload

      Examples:
        | the links on /held                                                       | the link     | where focus goes                                                      |
        | "Newer guide" and "Older guide" are held back                            | Newer guide  | the title of the next card, "Older guide"                             |
        | "Held guide" is held back, and Haystack couldn't describe "Failed guide" | Held guide   | the heading "Links to review", and the heading "Held back" is gone    |
        | only "Failed guide", which Haystack couldn't describe                    | Failed guide | the heading "Links to review", and the page says "Nothing to review." |

    @playwright:apps/worker/e2e/held.e2e.ts
    @integration:apps/worker/test/held.test.ts
    Scenario: Deleting without JavaScript
      Given my browser has JavaScript turned off
      And Haystack couldn't describe "A guide"
      When I press "Delete A guide"
      Then I see the page titled "Delete this link? - Haystack"
      And it shows "Title: A guide" and "Site:" with the link's host, not its whole address, as the card does
      When I press "Delete"
      Then I am back on /held, and the page's title is "Deleted “A guide” - Links to review - Haystack"
      And the status message "Deleted “A guide”." has focus
      And the link is deleted, with everything Haystack had recorded about it

    @playwright:apps/worker/e2e/held.e2e.ts
    Scenario: Keeping the link
      Given my browser has JavaScript turned off
      And I pressed "Delete A guide" on /held
      When I follow the link "Keep it and go back to the links to review"
      Then I am back on /held, at the card for "A guide"
      And nothing is deleted

  Rule: Nobody else can act on my links

    @integration:apps/worker/test/held.test.ts
    Scenario Outline: Releasing, retrying or deleting another person's link
      The answer is the same as for a link that doesn't exist, so it doesn't
      reveal that the other person's link does.

      Given another person's link is <in a state>
      When a request to <act on> it is sent with my session
      Then I see the page titled "Link not found - Haystack"
      And nothing changes in Haystack

      Examples:
        | in a state                     | act on  |
        | held back                      | release |
        | one Haystack couldn't describe | retry   |
        | held back                      | delete  |

    @integration:apps/worker/test/held.test.ts
    Scenario Outline: Pressing a button on /held after my session ended
      Given my browser has JavaScript turned off
      And I opened /held while I was signed in
      And my session has ended since
      When I press "<the button>"
      Then I am sent to Google to sign in, and back to /held afterwards
      And nothing changes in Haystack

      Examples:
        | the button      |
        | Release A guide |
        | Retry A guide   |
        | Delete A guide  |
