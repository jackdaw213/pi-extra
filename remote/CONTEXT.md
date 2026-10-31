# CONTEXT.md — Glossary

Domain terms for the pi-remote project. Glossary only — no implementation details.

## Terms

**Session**
A running pi process on a machine, whether started in a terminal by the user
or started remotely from the phone. A session ends when its pi process exits.
Distinct from a *session file* (the transcript on disk), which can outlive it.

**Session file**
The JSONL transcript pi writes under `~/.pi/agent/sessions/`. Read-only
evidence of past activity; not a live channel.

**Remote extension**
The pi extension, loaded by every session on a machine, that connects
outbound to the hub: it presents the session to the dashboard, streams session
output, receives messages, transfers files, and can start new sessions on its
machine. It never listens for network connections.

**Hub**
The always-on front door: a Docker container on the home lab that serves the
dashboard, keeps the live registry, and relays all traffic between the phone
and sessions. The hub runs no pi itself.

**Registry**
The hub's live picture of every connected session across all machines. Not a
file on any machine.

**Machine identity**
The stable identity a machine presents to the hub: hostname plus its
machine ID plus OS — so the dashboard always knows which session lives
where.

**Machine token**
The per-machine credential an extension presents to the hub on connect. The
hub decides which machines may connect.

**Hub password**
The single credential the phone uses to log in to the dashboard. Set once at
hub deployment; the browser remembers it.

**Dashboard**
The hub's landing page after login: every machine with its sessions and their
states (working, idle, blocked), plus starting a new session. Reached by
opening the bookmark.

**Attach**
Connecting the phone to an existing session so the phone can view its output
and send it messages while the session keeps running (typically in a terminal).

**Spawn**
Starting a new session from the phone. Two paths, in order: a live session's
extension starts it on that machine; or, with zero sessions, the hub wakes
the machine's cold-start stub.

**Cold start**
A machine with zero running sessions. Nothing of ours is alive there, so only
the cold-start stub — woken by the hub — can spawn a session.

**Cold-start stub**
The per-machine helper the hub wakes on demand to spawn the first session. It
runs only while answering and vanishes afterwards.

**Sandbox parity**
The guarantee that a session started from the phone is confined by exactly
the same systemd-run property set as a session started in a terminal.

**Home base folder**
`~/.pi` — the default working directory for sessions started from the phone,
matching the terminal launcher's fallback when pi is not started inside a
project.

**File exchange**
Moving files between the phone and a session through the chat, in both
directions: the phone attaches files to a message so the session can use them,
and a session can hand files back to the phone to download.

**Phone client**
The web app (PWA) served by the hub, added to the iPhone Home Screen. The
only thing that ever runs on the phone.

**Session history**
The full past transcript of a session — messages and tool activity — from
the session file. Opening a session shows it all at once, the way a chat
app shows a conversation; the same content `pi --resume` would show.

**Temp session**
A session created from the phone with the default spawn. Disposable by
design: swiping it away stops it and erases its transcript with it. It
stays listed after finishing; only an explicit swipe removes it.

**Normal session**
A session created from the phone as a keeper (or one started in a
terminal). Swiping it away stops it and removes it from the dashboard, but
its transcript survives and stays resumable.

**Question card**
The phone's rendering of an ask-user tool call: tappable option chips plus
the live composer, so a tap answers with that option and typed text
answers with a custom response.
