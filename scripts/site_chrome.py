#!/usr/bin/env python3
"""Keep the shared parts of every page in docs/*.html identical: the main navigation and the Content Security Policy.

    python scripts/site_chrome.py          # rewrite in place
    python scripts/site_chrome.py --check  # exit 1 if any page differs (used by tests)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
SHILLER_URL = re.search(r"url: '([^']+)'", (DOCS / "engine/data/shiller.js").read_text()).group(1)

NAV = [
    ("index.html", "Showdown"),
    ("strategies.html", "Strategies"),
    ("markets.html", "How markets move"),
    ("timing.html", "Market timing"),
    ("overfitting.html", "Overfitting"),
    ("market-making.html", "Market making"),
    ("atlas.html", "Algorithm atlas"),
    ("terminal.html", "Terminal"),
    ("metrics.html", "Metrics"),
    ("open-source.html", "Open source"),
    ("sources.html", "Sources"),
    ("disclaimer.html", "Disclaimer"),
]

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       f"connect-src 'self' {SHILLER_URL}; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")


def nav_html(current: str) -> str:
    items = []
    for href, label in NAV:
        cur = ' aria-current="page"' if href == current else ""
        items.append(f'          <li><a href="{href}"{cur}>{label}</a></li>')
    return '<nav class="site-nav" aria-label="Main">\n        <ul>\n' + "\n".join(items) + "\n        </ul>\n      </nav>"


def render(path: Path) -> str:
    s = path.read_text(encoding="utf-8")
    s = re.sub(r'<nav class="site-nav" aria-label="Main">.*?</nav>', lambda m: nav_html(path.name), s, count=1, flags=re.S)
    s = re.sub(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")', lambda m: m.group(1) + CSP + m.group(2), s, count=1)
    return s


def main() -> int:
    check = "--check" in sys.argv
    bad = []
    for p in sorted(DOCS.glob("*.html")):
        new = render(p)
        if new != p.read_text(encoding="utf-8"):
            bad.append(p.name)
            if not check:
                p.write_text(new, encoding="utf-8")
    missing = [h for h, _ in NAV if not (DOCS / h).exists()]
    if missing:
        print("nav links to missing pages:", ", ".join(missing))
        return 1
    if check and bad:
        print("out of date:", ", ".join(bad), "(run python scripts/site_chrome.py)")
        return 1
    print("updated: " + (", ".join(bad) if bad else "nothing"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
