# web-fetch-fallback

A pi **skill**: fetch web pages that block the normal fetch path — 403s,
CAPTCHA / Cloudflare challenge pages, login redirects, error-page or near-empty
extractions.

The agent climbs a ladder, one rung at a time, stopping at the first rung that
returns real content:

1. Normal fetch (`fetch_content` / `web_extract`).
2. **FlareSolverr** on the homelab (arch-server, port 8191) — solves
   Cloudflare-style JS challenges. Loses to Reddit's "Prove your humanity" wall
   and Redlib's "Gandalf" wall.
3. **Mirrors / alternate frontends** — for Reddit, Redlib instances
   (`redlib.freedit.eu` verified working 2026-11; instances churn).
4. Report which rungs blocked and stop.

`scripts/flare_fetch.py` does the FlareSolverr POST and HTML extraction and
prints a `VERDICT` line (`OK` / `CHALLENGE` / `ERROR` / `EMPTY`) plus the
extracted text — trust the verdict, never the byte size. Exit code 0 only on
`OK`. Flags: `--direct` (skip FlareSolverr, plain UA), `--raw` (JSON
endpoints), `--max-chars N`, `--timeout S`.

## Install

```
ln -s "$PWD/web-fetch-fallback" ~/.pi/agent/skills/web-fetch-fallback
```

The FlareSolverr endpoint defaults to `http://192.168.10.202:8191/v1`;
override with `PI_FLARESOLVERR_URL`.

Verified live against r/LocalLLaMA post 1xkm2yb: Reddit blocked every direct
path (www, old.reddit, `.json`, r.jina.ai); FlareSolverr + the `freedit.eu`
Redlib mirror returned the full 21k-char thread.
