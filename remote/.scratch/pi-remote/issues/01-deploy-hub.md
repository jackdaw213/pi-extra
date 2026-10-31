# 01 — Deploy the hub on the home lab

**What to build:** the always-on front door, live on the lab. From the phone's
perspective: a bookmark that answers with a login page, and after login an
empty dashboard waiting for machines.

**Blocked by:** None — can start immediately.

**Status:** done (the home lab is read-only for agents; the
operator runs this)

- [ x] From `hub/` on arch-server: `PI_REMOTE_PASSWORD=<password> docker compose up -d --build`
- [ x] Create the tokens file in the volume and add this PC's machine token
      (printed by ticket 02; or generate one now with
      `openssl rand -hex 32` and keep it for 02)
- [ x] `curl http://<lab-ip>:8787/api/health` returns `{"ok":true}` from this PC
- [ x] Optional: note the hub address the phone will use (lab IP:8787 over
      ZeroTier/LAN, or a DuckDNS link via the lab's reverse proxy)
