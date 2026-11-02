#!/usr/bin/env python3
"""Fetch a URL through the fallback path: FlareSolverr on the homelab, or direct.

Prints a VERDICT line (OK / CHALLENGE / ERROR / EMPTY), the final URL, and the
extracted text, so the caller can judge success by content, not byte size.

Exit code 0 only on VERDICT: OK.
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
FLARE_DEFAULT = "http://192.168.10.202:8191/v1"

CHALLENGE_MARKERS = [
    "prove your humanity", "just a moment", "checking your browser",
    "attention required", "enable javascript and cookies", "verify you are human",
    "are you a robot", "unusual traffic", "gandalf is checking",
    "sign in to continue", "log in to continue", "you have been blocked",
    "access denied", "captcha",
]
ERROR_MARKERS = [
    "this site can\u2019t be reached", "this site can't be reached",
    "temporarily down", "err_http2_protocol_error", "err_connection",
    "err_name_not_resolved", "the webpage at",
]


def extract_text(raw_html):
    h = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw_html, flags=re.S | re.I)
    h = re.sub(r"<br[^>]*>|</p>|</div>|</h\d>|</li>|</blockquote>", "\n", h)
    t = re.sub(r"<[^>]+>", " ", h)
    t = html.unescape(re.sub(r"[ \t]+", " ", t))
    return re.sub(r"\n\s*\n+", "\n", t).strip()


def classify(text, final_url):
    # Challenge/error pages carry their marker in the head (title + first
    # lines). Body mentions (e.g. a thread discussing captchas) stay after it.
    head = text[:1500].lower()
    if len(text) < 120:
        return "EMPTY"
    if "/login" in (final_url or "").lower():
        return "CHALLENGE"
    if any(m in head for m in CHALLENGE_MARKERS):
        return "CHALLENGE"
    if any(m in head for m in ERROR_MARKERS):
        return "ERROR"
    return "OK"


def via_flaresolver(url, base, timeout_s):
    body = json.dumps({"cmd": "request.get", "url": url,
                       "maxTimeout": int(timeout_s * 1000)}).encode()
    req = urllib.request.Request(base, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s + 30) as r:
        d = json.loads(r.read())
    sol = d.get("solution") or {}
    return sol.get("response", ""), sol.get("url", url), ""


def via_direct(url, timeout_s):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        final = r.geturl()
        ctype = r.headers.get("Content-Type", "")
        data = r.read()
    text = data.decode("utf-8", "replace")
    if "json" in ctype:
        return text, final, "json"
    return text, final, ""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url")
    ap.add_argument("--direct", action="store_true",
                    help="fetch without FlareSolverr (plain UA)")
    ap.add_argument("--raw", action="store_true",
                    help="skip HTML extraction (JSON/text endpoints)")
    ap.add_argument("--max-chars", type=int, default=12000)
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--flare", default=os.environ.get("PI_FLARESOLVERR_URL",
                                                      FLARE_DEFAULT))
    a = ap.parse_args()

    try:
        if a.direct:
            body, final, ctype = via_direct(a.url, a.timeout)
        else:
            body, final, ctype = via_flaresolver(a.url, a.flare, a.timeout)
    except Exception as e:
        print(f"VERDICT: ERROR\nSOURCE: {'direct' if a.direct else 'flaresolverr'}"
              f"\nFINAL_URL: {a.url}\nERROR: {e}")
        sys.exit(1)

    if a.raw or ctype == "json":
        text = body.strip()
    else:
        text = extract_text(body)

    verdict = classify(text, final)
    print(f"VERDICT: {verdict}")
    print(f"SOURCE: {'direct' if a.direct else 'flaresolverr'}")
    print(f"FINAL_URL: {final}")
    print(f"CHARS: {len(text)}")
    print("-" * 20)
    print(text[: a.max_chars])
    sys.exit(0 if verdict == "OK" else 1)


if __name__ == "__main__":
    main()
