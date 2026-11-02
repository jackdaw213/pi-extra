# pi-extra

My pi add-ons. One folder per extension, each self-contained;
`~/.pi/agent/extensions/` points at them.

- **clipboard-image/** — smart-paste the clipboard into pi: an image queues
  (count line above the editor), text inserts; Enter on an empty editor sends
  the queue. Includes the Konsole keytab that makes the SofleV2 hardware
  copy/paste keys work.
- **session-name/** — auto-names new sessions from the first message.
- **remote/** — use pi from the phone via the hub dashboard.
- **web-fetch-fallback/** — skill for pages that block normal fetching (403s,
  CAPTCHA / Cloudflare challenges): a fetch ladder — normal fetch, FlareSolverr
  on the homelab, then site mirrors — with a verdict-checked fetch script.
  `~/.pi/agent/skills/` points at it.

Install steps live in each folder's README.
