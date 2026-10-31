Feature: pi-remote phone UI — rendering, history, subagents, questions, delete
  Rich rendering and chat-app history on the phone, visible subagents,
  answerable questions, and swipe-to-delete. Vocabulary per CONTEXT.md;
  delete semantics per ADR 0006. Spec: .scratch/phone-ui/001-phone-ui.md

  Background:
    Given a hub reachable on the network with a login password
    And a machine whose token the hub accepts

  Scenario: Assistant reply renders markdown
    Given I am attached to a session from the phone
    When the assistant reply contains bold text, a list, and a fenced code block
    Then the reply shows bold text, a real list, and a highlighted code block
    And raw markdown syntax does not appear

  Scenario: Table renders as a table
    Given I am attached to a session from the phone
    When an assistant reply contains a markdown table
    Then I see a table with rows and columns
    And no pipe characters from the table syntax remain visible

  Scenario: Mermaid renders as a diagram
    Given I am attached to a session from the phone
    When an assistant reply contains a mermaid code block
    Then I see the diagram rendered
    But if the diagram fails to parse I see the mermaid source instead

  Scenario: Model-sent HTML never executes
    Given I am attached to a session from the phone
    When an assistant reply contains inline HTML or a script tag
    Then it renders as plain text, not markup

  Scenario: Pasting a screenshot attaches it
    Given I am attached to a session from the phone
    When I paste a screenshot into the composer
    Then the image uploads to the session as an attachment
    And the composer shows the upload just like the attach button does
    But pasting plain text still types it into the field

  Scenario: Composer spans the card width
    Given I am attached to a session from the phone
    Then the composer text field spans the same width as the tool cards
    And the attach and send controls sit inside the field's edges

  Scenario: Streaming renders progressively
    Given the assistant is streaming a reply with markdown
    Then formatting appears while the reply streams

  Scenario: Connection trouble shows in the status line
    Given a pi session running in a terminal with the extension loaded
    When the hub is unreachable and the extension retries
    Then the retry status appears in the terminal's status line
    And the transcript text is never overprinted
    And the status clears when the hub connection returns

  Scenario: Attach shows the entire past transcript
    Given a session with past messages and tool activity
    When I open it from the dashboard
    Then I see its entire history immediately, messages and tool cards, oldest first
    And new live output appends below the history without duplication

  Scenario: Attach without history support shows a note
    Given a session whose extension predates history support
    When I attach
    Then the live view still renders
    And a note tells me that session's extension sent no history

  Scenario: History renders with the same richness
    Given a session whose history contains markdown tables and code blocks
    When I open it from the dashboard
    Then the history renders with tables, highlighting, and diagrams like a live reply

  Scenario: Attach while the session is working
    Given a session that is working right now
    When I attach
    Then I see the history up to now and live output continues below it

  Scenario: Subagent work nests under its card
    Given the main session is running a subagent
    When the subagent calls tools
    Then the subagent's tool calls appear nested inside the subagent's card
    And they do not appear in the main stream

  Scenario: Running subagent count
    Given two subagents are running
    Then their activity shows a count of 2 running
    When one finishes
    Then the count updates

  Scenario: Subagent card collapses
    Given a subagent card with nested activity
    When I tap its header
    Then the nested activity expands
    When I tap its header again
    Then the nested activity collapses

  Scenario: Question renders as a card
    Given the agent calls an ask-user tool
    Then a question card shows the question and its option chips
    And the session state shows blocked

  Scenario: Tapping an option answers
    Given a question card with option chips
    When I tap an option
    Then the agent receives that option as the answer and continues
    And the card shows my chosen answer

  Scenario: Typing a custom answer
    Given a question card is open
    When I type text in the composer and send
    Then the agent receives my text as the answer and continues
    And the composer returns to normal messaging

  Scenario: Swipe reveals delete
    Given the dashboard lists sessions
    When I swipe a session card from right to left
    Then a delete action is revealed
    When I tap delete
    Then the card animates away and is removed from the dashboard
    And the dashboard tells me the delete was sent

  Scenario: Swiping all the way deletes at once
    Given the dashboard lists sessions
    When I drag a session card past the full-swipe threshold
    Then the session is deleted without tapping the delete button

  Scenario: Deleting a temp session erases the transcript
    Given a temp session created by default from the phone
    When I swipe delete on its card
    Then the session stops, its card disappears, and its transcript file is erased

  Scenario: Deleting a normal session keeps the transcript
    Given a normal session created from the phone
    When I swipe delete on its card
    Then the session stops and its card disappears
    But its transcript survives and stays resumable

  Scenario: Deleting a terminal session keeps the transcript
    Given a session started in a terminal
    When I swipe delete on its card
    Then its pi process stops and its card disappears
    But its transcript survives and stays resumable

  Scenario: Spawn defaults to a temp session
    Given the dashboard shows one floating plus button at the bottom
    When I tap the plus button
    Then a temp session starts on the connected machine and its card shows the temp kind
    When I press and hold the plus button
    Then a normal session starts instead and its card shows the normal kind
    But with several machines connected the plus button first asks which machine

  Scenario: Idle sign-out
    Given I am signed in on the phone
    When I use the app and then leave it untouched for 15 minutes
    Then I am signed out and see the login view
    But as long as I keep using it the countdown keeps resetting
    And a session left open but untouched still counts as idle

  Scenario: Subagent sessions never appear in the list
    Given a session spawns subagents
    When the subagents run
    Then the dashboard list shows only the parent session
    And the subagents' activity appears nested in the parent chat

  Scenario: Todo list panel above the composer
    Given a session uses the todo tool
    Then the current todo list appears in a panel between the chat and the composer
    And the panel collapses to save vertical space

  Scenario: Running agents panel above the composer
    Given a session runs subagents
    Then a panel lists the running agents with a count between the chat and the composer
    And the panel collapses to save vertical space

  Scenario: Question appears in the terminal too
    Given the agent calls an ask-user tool in a terminal session
    Then the question opens as pi's own dialog in that terminal
    And the phone shows the same question card
    When either surface answers first
    Then the tool completes with a success result carrying the answer
    And the other surface shows the question settled

  Scenario: The question card replaces the ask tool card
    Given the agent calls an ask-user tool
    Then the phone shows the question card only
    And no raw ask-user tool card appears next to it
    But if no question card could be created the completed call shows as an ordinary tool card
