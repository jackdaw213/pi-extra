# 03 — Phone end-to-end acceptance

**What to build:** the whole point, experienced from the couch: attach to a
real session from the iPhone over ZeroTier, steer it, start a session, move a
file — all through the bookmark.

**Blocked by:** 02 — Install pi-remote on this PC and verify against the lab hub

**Status:** ready-for-human (needs the physical phone; agent verifies server-side)

- [ ] Open `http://<lab-ip>:8787` in Safari, log in, add to Home Screen
- [ ] Dashboard shows this PC and its sessions; states update live
- [ ] Attach to the operator's active session; output streams while the terminal works
- [ ] Send a message while busy (steer) and while idle (new turn); abort works
- [ ] Start a new session from the phone; verify its systemd unit properties match the terminal launcher
- [ ] Attach a file to a message; the agent reads it; `send_file_to_phone` returns a file to the phone
- [ ] Stop a phone-started session from the phone
