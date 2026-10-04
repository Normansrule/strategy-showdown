#!/usr/bin/env python3
"""Download Robert Shiller's monthly S&P Composite data (as packaged by datasets/s-and-p-500) for LOCAL use.

    python scripts/fetch_shiller.py      # writes docs/data/local/shiller.csv (gitignored, never deployed)

The file is pinned to one commit of the package and must match its SHA-256 (the same pin as
docs/engine/data/shiller.js). The original data carry no explicit licence, so this project never commits or
deploys them; every user downloads their own copy. Standard library only.
"""
from __future__ import annotations

import hashlib
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "docs/engine/data/shiller.js").read_text(encoding="utf-8")
URL = re.search(r"url: '([^']+)'", JS).group(1)
SHA = re.search(r"sha256: '([0-9a-f]{64})'", JS).group(1)
OUT = ROOT / "docs/data/local/shiller.csv"


def main() -> int:
    req = urllib.request.Request(URL, headers={"User-Agent": "strategy-showdown (educational backtests)"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (fixed https URL)
        data = r.read(3 * 1024 * 1024)
    got = hashlib.sha256(data).hexdigest()
    if got != SHA:
        print(f"SHA-256 mismatch: got {got}, expected {SHA}", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(data) // 1024} KiB, sha256 {got[:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
