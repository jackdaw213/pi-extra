---
name: web-fetch-fallback
description: "Fetch web pages that block the normal fetch path: 403s, CAPTCHA / Cloudflare challenge pages, login redirects, and error-page or near-empty extractions. Climb the ladder — normal fetch, then FlareSolverr on the homelab, then site mirrors — using this skill's script. Trust the VERDICT line, not byte size."
---

# Web fetch fallback

Some sites serve bots a challenge page instead of content. Byte size does not prove success — a 258 KB Chrome error page is still an error page. Climb this ladder one rung at a time and stop at the first rung that returns real content.

## Rung 1 — normal fetch

Use `fetch_content` (or `web_extract`).

Done when: the text carries the page's actual content.

## Rung 2 — FlareSolverr on the homelab

```
python3 ~/.pi/agent/skills/web-fetch-fallback/scripts/flare_fetch.py "<url>"
```

The script POSTs `request.get` to FlareSolverr (arch-server, port 8191) and prints `VERDICT`, `SOURCE`, `FINAL_URL`, `CHARS`, then the extracted text. Flags: `--raw` to skip HTML extraction (JSON endpoints), `--max-chars N`, `--timeout S`.

Done when: `VERDICT: OK` and the text is the real page.

Scope of this rung: FlareSolverr solves Cloudflare-style JS challenges. Reddit's "Prove your humanity" wall and Redlib's "Gandalf" wall beat it — for those, go straight to rung 3.

## Rung 3 — mirrors and alternate frontends

Reddit serves the same threads through Redlib mirrors. Point the rung-2 script at a mirror and rotate until `VERDICT: OK`:

- `redlib.freedit.eu` — returned the full thread, verified 2026-11
- Rotation set, challenged or rate-limited at verification time: `redlib.catsarch.com`, `redlib.perennialte.ch`, `redlib.privacyredirect.com`, `red.artemislena.eu`

URL shape: `https://<instance>/r/<sub>/comments/<id>/`

Instances churn — when the list rots, search the web for `<site> alternative frontend` and refresh it. For non-Reddit sites: prefer the site's own API or an official alternate frontend first.

Done when: a mirror returns `VERDICT: OK`.

## Rung 4 — report and stop

Every rung failed: report which sites blocked which rung, then stop. Repeat attempts harden anti-bot blocks.

## Challenge markers (what a fail looks like)

"Prove your humanity" · "Just a moment" · "Checking your browser" · "Enable JavaScript and cookies" · "Gandalf is checking your connection" · "unusual traffic" · "sign in to continue" · `old.reddit.com/login` redirects · Chrome network-error pages ("This site can't be reached", `ERR_..._PROTOCOL_ERROR`).

The script classifies these for you; when you read a page by hand, judge by these markers, never by response size.
