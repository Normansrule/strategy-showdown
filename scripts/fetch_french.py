"""Download the Kenneth R. French Data Library files and build docs/data/local/french.json (gitignored).

    python scripts/fetch_french.py                 # download the four files, parse, write the dataset
    python scripts/fetch_french.py --offline DIR   # build from zips/CSVs already in DIR (no network)
    python scripts/fetch_french.py --save-zips DIR # also keep the downloaded zips in DIR (for --offline later)

The data are NEVER committed or deployed: the library publishes no licence, so redistribution rights are
unclear. The output path is gitignored; CI checks that nothing under docs/data/local/ is tracked.

Status: tested with fixtures (tests/fixtures/french/, invented values in the real layout); the first live run
happens in CI (.github/workflows/live-data.yml) or on your machine. The development environment where this
was written could not reach mba.tuck.dartmouth.edu.

Standard library only. Parsing and assembly are in scripts/french_csv.py (Python twin of docs/engine/data/).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import french_csv  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data" / "local" / "french.json"
USER_AGENT = "strategy-showdown/0.1 (+https://github.com/Normansrule/strategy-showdown; educational backtests)"
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024  # the largest file here is well under 1 MB; anything huge is wrong
TIMEOUT_S = 60
PAUSE_S = 1.0  # be polite: one request per second

# Replication gate for --check-replication. The library prints returns to 2 decimals of a percent (0.00005 in
# decimal after rounding to the nearest 0.01%). Rebuilding Mom = ½(SH + BH) − ½(SL + BL) from four rounded inputs
# can be off by ½·4·0.00005 = 0.0001, and the published Mom is itself rounded (another 0.00005), so pure rounding
# can produce up to 0.00015. Anything larger means the files disagree (different vintages, or a layout change).
REPLICATION_MAX_ABS_DIFF = 0.00015 + 1e-12
REPLICATION_MIN_CORRELATION = 0.9999


def download(url: str) -> bytes:
    """GET url with a timeout, size cap and 3 attempts (exponential backoff). Only https to the library host."""
    if not url.startswith(french_csv.FRENCH_BASE_URL):
        raise ValueError(f"refusing to download from an unexpected URL: {url}")
    last: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                length = resp.headers.get("Content-Length")
                if length and int(length) > MAX_DOWNLOAD_BYTES:
                    raise ValueError(f"{url}: {length} bytes exceeds the {MAX_DOWNLOAD_BYTES} byte cap")
                data = resp.read(MAX_DOWNLOAD_BYTES + 1)
                if len(data) > MAX_DOWNLOAD_BYTES:
                    raise ValueError(f"{url}: response exceeds the {MAX_DOWNLOAD_BYTES} byte cap")
                return data
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                break
            time.sleep(2 ** attempt * 2)
    raise RuntimeError(f"could not download {url}: {last}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--offline", metavar="DIR", help="build from files already downloaded into DIR")
    ap.add_argument("--save-zips", metavar="DIR", help="keep the downloaded zips in DIR")
    ap.add_argument("--out", default=str(OUT), help="output path (default: docs/data/local/french.json)")
    ap.add_argument("--required-only", action="store_true", help="skip the optional Mom and 6-portfolio files")
    ap.add_argument("--check-replication", action="store_true",
                    help="exit non-zero unless Mom rebuilt from the 6 portfolios matches the published Mom")
    args = ap.parse_args(argv)

    files: list[tuple[str, bytes]] = []
    downloads: dict[str, dict] = {}
    wanted = [f for f in french_csv.FRENCH_FILES if f["required"] or not args.required_only]
    if args.offline:
        d = Path(args.offline)
        for f in wanted:
            p = d / f["name"]
            if not p.exists():
                alt = d / f["name"].replace("_CSV.zip", ".CSV")
                p = alt if alt.exists() else p
            if not p.exists():
                if f["required"]:
                    print(f"error: {f['name']} not found in {d}", file=sys.stderr)
                    return 2
                print(f"note: optional {f['name']} not found in {d}; skipped")
                continue
            files.append((p.name, p.read_bytes()))
    else:
        for i, f in enumerate(wanted):
            if i:
                time.sleep(PAUSE_S)
            print(f"downloading {f['url']}")
            try:
                data = download(f["url"])
            except Exception as e:  # noqa: BLE001
                if f["required"]:
                    print(f"error: {e}", file=sys.stderr)
                    return 1
                print(f"warning: optional file skipped: {e}")
                continue
            downloads[f["name"]] = {"url": f["url"], "downloadedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            files.append((f["name"], data))
            if args.save_zips:
                Path(args.save_zips).mkdir(parents=True, exist_ok=True)
                (Path(args.save_zips) / f["name"]).write_bytes(data)

    try:
        ds = french_csv.load_french_files(files)
    except french_csv.FrenchDataError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    for rec in ds["provenance"]["files"]:
        rec.update(downloads.get(rec["name"], {}))
    ds["provenance"]["builtBy"] = "scripts/fetch_french.py" + (" --offline" if args.offline else "")
    ds["provenance"]["localOnly"] = "Local copy for your own use. Never committed or deployed (redistribution rights unclear)."

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(ds, separators=(",", ":"), ensure_ascii=False))

    al = ds["provenance"]["alignment"]
    print(f"wrote {out}: {len(ds['dates'])} months {ds['dates'][0]}..{ds['dates'][-1]}, "
          f"{len(ds['assets'])} industries, factors {', '.join(ds['factors'])}")
    print(f"  title: {ds['title']}")
    print(f"  dropped months: {ds['provenance']['droppedMonths']} (missing values {al['missingValueMonths']}, "
          f"Mom unavailable {al['momentumUnavailableMonths']}, gaps {al['gapTrimmedMonths']})")
    for rec in ds["provenance"]["files"]:
        print(f"  {rec['name']}: sha256 {rec['sha256']}, CRSP vintage {rec['crspVintage']}")
    rep = ds["replication"]
    if rep.get("available"):
        print(f"  Mom replication: {rep['months']} months, max |diff| {rep['maxAbsDiff']:.6f}, "
              f"correlation {rep['correlation']:.6f}, columns {rep['columnMapping']}")
    else:
        print(f"  Mom replication: not available ({rep.get('reason')})")
    if args.check_replication:
        problems = check_replication(ds)
        for p in problems:
            print(f"REPLICATION FAILED: {p}", file=sys.stderr)
        if problems:
            return 3
        print(f"  replication check passed (max |diff| <= {REPLICATION_MAX_ABS_DIFF:.5f}, correlation >= {REPLICATION_MIN_CORRELATION})")
    return 0


def check_replication(ds: dict) -> list[str]:
    rep = ds.get("replication") or {}
    if not rep.get("available"):
        return [f"replication not available: {rep.get('reason')}"]
    problems = []
    if rep["maxAbsDiff"] > REPLICATION_MAX_ABS_DIFF:
        problems.append(f"max |rebuilt − published Mom| = {rep['maxAbsDiff']:.6f} > {REPLICATION_MAX_ABS_DIFF:.5f}")
    if rep["correlation"] < REPLICATION_MIN_CORRELATION:
        problems.append(f"correlation {rep['correlation']:.6f} < {REPLICATION_MIN_CORRELATION}")
    if rep.get("columnMapping") != "by-name":
        problems.append(f"six-portfolio columns were mapped {rep.get('columnMapping')} (header {rep.get('headerUsed')}); check the file layout")
    return problems


if __name__ == "__main__":
    sys.exit(main())
