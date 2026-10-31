Feature: pi-remote — control pi sessions from a phone
  The hub runs on the home lab; the extension runs inside every pi session;
  the phone uses the PWA. Vocabulary per CONTEXT.md; decisions per ADR 0001-0005.

  Background:
    Given a hub reachable on the network with a login password
    And a machine whose token the hub accepts

  Scenario: Machine identifies itself to the dashboard
    Given a pi session running on the machine
    When the extension connects out to the hub
    Then the dashboard shows the machine with its hostname, machine id, and addresses
    And the session card shows its name, folder, model, and state "idle"

  Scenario: Dashboard login
    Given the hub password
    When I log in with the correct password
    Then I stay logged in on the phone
    When I log in with a wrong password
    Then the hub rejects me

  Scenario: Attach and watch live output
    Given I am attached to a terminal session from the phone
    When the agent in that session streams a reply in the terminal
    Then the phone shows the same output, including tool calls, as it happens

  Scenario: Terminal activity reaches the phone
    Given I am attached to a session from the phone
    When a prompt is typed in the terminal
    Then the phone shows that user message too

  Scenario: Send a message while the agent is idle
    Given the session state is "idle"
    When I send a message from the phone
    Then the agent starts a new turn with that message

  Scenario: Send a message while the agent is working
    Given the session state is "working"
    When I send a message from the phone with delivery "steer"
    Then the agent receives it after its current turn
    And the session state returns to "idle" when the run settles

  Scenario: Abort a run from the phone
    Given the session state is "working"
    When I tap abort
    Then the run stops and the session state returns to "idle"

  Scenario: Stop a remote-started session from the phone
    Given a session the phone started (mode "remote")
    When I tap stop
    Then the session exits and disappears from the dashboard
    But a terminal session offers no stop, only abort

  Scenario: Start a new session while one is alive
    Given the machine has at least one live session
    When I start a new session from the phone
    Then a new sandboxed session appears on the dashboard
    And it is confined by the same systemd-run property set as terminal sessions

  Scenario: Cold start on a machine with zero sessions
    Given the machine has no live sessions and the cold-start units are armed
    When I start a new session from the phone
    Then the hub wakes the machine's stub and the stub spawns the session
    And the stub is gone again right after

  Scenario: Cold start without systemd
    Given a machine without a working systemd user manager
    When I start a new session from the phone
    Then the dashboard reports that always-on is unavailable for that machine

  Scenario: Send a file from the phone to a session
    Given I am attached to a session
    When I attach a file to a message and send it
    Then the file lands in the session's inbox on the machine
    And the agent is told the file's absolute path in the message text

  Scenario: Send an image from the phone to a session
    Given I am attached to a session
    When I attach an image and send it
    Then the model receives the image inline in the message

  Scenario: The session sends a file to the phone
    Given I am attached to a session
    When the model calls send_file_to_phone with a path
    Then the phone shows a download card with the file

  Scenario: A dead session disappears
    Given a session shown on the dashboard
    When its pi process is killed hard
    Then the hub drops it from the registry

  Scenario: Extension reconnects after a hub restart
    Given a session connected to the hub
    When the hub restarts
    Then the extension reconnects on its own
    And the session reappears on the dashboard

  Scenario: A machine without the extension shows nothing
    Given a machine whose sessions never connect out
    Then the dashboard shows no sessions for it
