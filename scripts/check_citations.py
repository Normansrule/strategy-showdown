"""Check docs/data/citations.json against Crossref (live) or validate its schema (--offline).

    python scripts/check_citations.py            # live: every DOI resolved at api.crossref.org and compared
    python scripts/check_citations.py --offline  # schema only: no network

Live mode compares, for each entry with a DOI:
  - title: normalised; the stored title must equal Crossref's title, or Crossref's "title: subtitle", or a
    leading part of it that ends at a subtitle separator (":", "?", ".", " - ", " — ")
  - year: must equal a Crossref year (issued, published-print or published-online); ±1 is accepted and
    reported (online-first vs print), anything else fails
  - first author's family name (accent- and case-insensitive)
  - container (journal) title, ignoring a leading "The", "&" vs "and", and Crossref's short title
Exit status is non-zero on any mismatch or unresolvable DOI.

Politeness: set CROSSREF_MAILTO=you@example.org to join Crossref's "polite pool". Requests are spaced at least
one second apart; 429 and 5xx responses are retried with exponential backoff (and Retry-After if sent).

Offline mode checks: every entry has key/title/authors/year/verification (year may be null only for
non-dated sources such as a web page), keys are unique, DOIs are well formed, and every source key referenced
in docs/engine/strategies/index.js, docs/engine/metrics.js and docs/engine/sims/*.js exists in citations.json.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CITATIONS = ROOT / "docs" / "data" / "citations.json"
ENGINE_FILES = [ROOT / "docs/engine/strategies/index.js", ROOT / "docs/engine/metrics.js"]
ENGINE_GLOBS = ["docs/engine/sims/*.js"]
REQUIRED = ("key", "title", "authors", "year", "verification")
VERIFICATION_VALUES = {"crossref", "publisher", "secondary", "unverified", "manual"}
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
KEY_RE = re.compile(r"^[a-z0-9_]+$")
MIN_INTERVAL_S = 1.0


# ---------------------------------------------------------------- normalisation and comparison

def _fold(s: str) -> str:
    s = unescape(re.sub(r"<[^>]+>", "", s or ""))  # Crossref titles may contain <i>…</i> or entities
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def norm_title(s: str) -> str:
    s = _fold(s).replace("&", " and ")
    s = re.sub(r"[‐‑‒–—−-]", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_container(s: str) -> str:
    s = norm_title(s)
    return re.sub(r"^the ", "", s)


def title_matches(stored: str, cr_titles: list[str], cr_subtitles: list[str]) -> bool:
    want = norm_title(stored)
    if not want:
        return False
    for t in cr_titles or []:
        candidates = [t] + [f"{t}: {st}" for st in (cr_subtitles or [])]
        for full in candidates:
            if norm_title(full) == want:
                return True
            # A leading part of the full title that ends at a subtitle separator.
            parts = re.split(r"(?<=[:?.])\s+|\s+[-—–]\s+", full)
            for k in range(1, len(parts)):
                if norm_title(" ".join(parts[:k])) == want:
                    return True
    return False


def crossref_years(msg: dict) -> list[int]:
    years = []
    for field in ("issued", "published-print", "published-online", "published"):
        parts = (msg.get(field) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            years.append(int(parts[0][0]))
    return sorted(set(years))


def compare_entry(entry: dict, msg: dict) -> tuple[list[str], list[str]]:
    """Return (errors, notes) for one citation against a Crossref 'message' object."""
    errors, notes = [], []
    if not title_matches(entry["title"], msg.get("title") or [], msg.get("subtitle") or []):
        cr = (msg.get("title") or [""])[0]
        sub = (msg.get("subtitle") or [""])
        errors.append(f"title differs: stored {entry['title']!r}, Crossref {cr!r}" + (f" (subtitle {sub[0]!r})" if sub and sub[0] else ""))
    years = crossref_years(msg)
    y = entry.get("year")
    if not years:
        notes.append("Crossref gives no year")
    elif y in years:
        pass
    elif any(abs(y - cy) == 1 for cy in years):
        notes.append(f"year {y} is within 1 of Crossref {years} (online-first vs print); accepted")
    else:
        errors.append(f"year differs: stored {y}, Crossref {years}")
    authors = msg.get("author") or []
    first = next((a for a in authors if a.get("sequence") == "first"), authors[0] if authors else None)
    want = _fold((entry.get("authors") or [{}])[0].get("family", "")).strip()
    got = _fold((first or {}).get("family") or (first or {}).get("name") or "").strip()
    if not first:
        errors.append("Crossref lists no authors")
    elif want != got:
        errors.append(f"first author differs: stored {want!r}, Crossref {got!r}")
    journal = entry.get("journal")
    if journal:
        conts = [norm_container(c) for c in (msg.get("container-title") or []) + (msg.get("short-container-title") or [])]
        if not conts:
            notes.append("Crossref gives no container title")
        elif norm_container(journal) not in conts:
            errors.append(f"journal differs: stored {journal!r}, Crossref {(msg.get('container-title') or [''])[0]!r}")
    return errors, notes


# ---------------------------------------------------------------- offline schema checks

def referenced_keys() -> dict[str, list[str]]:
    """Map source key -> files that reference it."""
    files = list(ENGINE_FILES)
    for g in ENGINE_GLOBS:
        files += sorted(ROOT.glob(g))
    refs: dict[str, list[str]] = {}
    for f in files:
        if not f.exists():
            continue
        src = f.read_text(encoding="utf-8")
        keys = set(re.findall(r"\bkey:\s*['\"]([A-Za-z0-9_]+)['\"]", src))
        for m in re.finditer(r"\bsources:\s*\[([^\]]*)\]", src):
            keys.update(re.findall(r"^\s*['\"]([A-Za-z0-9_]+)['\"]\s*$", m.group(1).replace(",", "\n"), re.M))
        for k in keys:
            refs.setdefault(k, []).append(str(f.relative_to(ROOT)))
    return refs


def validate_schema(entries) -> list[str]:
    errs = []
    if not isinstance(entries, list) or not entries:
        return ["citations.json must be a non-empty JSON array"]
    seen = set()
    for i, e in enumerate(entries):
        where = f"entry {i} ({e.get('key', '?') if isinstance(e, dict) else '?'})"
        if not isinstance(e, dict):
            errs.append(f"{where}: not an object")
            continue
        for f in REQUIRED:
            if f not in e:
                errs.append(f"{where}: missing field '{f}'")
        k = e.get("key")
        if not isinstance(k, str) or not KEY_RE.match(k):
            errs.append(f"{where}: key must match {KEY_RE.pattern}")
        elif k in seen:
            errs.append(f"{where}: duplicate key")
        else:
            seen.add(k)
        if not isinstance(e.get("title"), str) or not e.get("title", "").strip():
            errs.append(f"{where}: title must be a non-empty string")
        auth = e.get("authors")
        if not isinstance(auth, list) or not auth or not all(isinstance(a, dict) and str(a.get("family", "")).strip() for a in auth):
            errs.append(f"{where}: authors must be a non-empty list of {{family, given}}")
        y = e.get("year")
        if y is None:
            if e.get("doi"):
                errs.append(f"{where}: an entry with a DOI needs a year")
        elif not isinstance(y, int) or not 1600 <= y <= 2100:
            errs.append(f"{where}: year must be an integer (or null for an undated web source)")
        v = e.get("verification")
        if v not in VERIFICATION_VALUES:
            errs.append(f"{where}: verification must be one of {sorted(VERIFICATION_VALUES)}")
        doi = e.get("doi")
        if doi is not None:
            if not isinstance(doi, str) or not DOI_RE.match(doi) or doi.lower().startswith(("http", "doi:")):
                errs.append(f"{where}: malformed DOI {doi!r} (use the bare form 10.xxxx/...)")
        elif v == "crossref":
            errs.append(f"{where}: verification 'crossref' needs a DOI")
        if doi is None and not e.get("url"):
            errs.append(f"{where}: needs a DOI or a URL")
    for k, files in sorted(referenced_keys().items()):
        if k not in seen:
            errs.append(f"source key '{k}' used in {', '.join(sorted(set(files)))} is missing from citations.json")
    return errs


# ---------------------------------------------------------------- live Crossref

class Crossref:
    def __init__(self, mailto: str | None):
        self.mailto = mailto
        self.last = 0.0
        ua = "strategy-showdown-citation-check/0.1 (+https://github.com/Normansrule/strategy-showdown"
        self.ua = ua + (f"; mailto:{mailto})" if mailto else ")")

    def work(self, doi: str) -> dict | None:
        url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/()._-;:")
        if self.mailto:
            url += "?" + urllib.parse.urlencode({"mailto": self.mailto})
        delay = 2.0
        for attempt in range(5):
            wait = MIN_INTERVAL_S - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.ua, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read(5 * 1024 * 1024))["message"]
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code == 429 or e.code >= 500:
                    ra = e.headers.get("Retry-After") if e.headers else None
                    time.sleep(float(ra) if ra and ra.isdigit() else delay)
                    delay *= 2
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(delay)
                delay *= 2
        raise RuntimeError(f"Crossref did not answer for {doi} after 5 attempts")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Check docs/data/citations.json (Crossref or schema only).")
    ap.add_argument("--offline", action="store_true", help="schema checks only; no network")
    ap.add_argument("--file", default=str(CITATIONS))
    args = ap.parse_args(argv)
    entries = json.loads(Path(args.file).read_text(encoding="utf-8"))

    errs = validate_schema(entries)
    for e in errs:
        print(f"SCHEMA  {e}")
    if args.offline:
        n_doi = sum(1 for e in entries if isinstance(e, dict) and e.get("doi"))
        print(f"offline: {len(entries)} entries, {n_doi} with DOIs, {len(referenced_keys())} keys referenced by the engine; "
              f"{'OK' if not errs else f'{len(errs)} problem(s)'}")
        return 1 if errs else 0

    cr = Crossref(os.environ.get("CROSSREF_MAILTO") or None)
    failures = len(errs)
    for e in entries:
        doi = e.get("doi") if isinstance(e, dict) else None
        if not doi:
            continue
        try:
            msg = cr.work(doi)
        except Exception as ex:  # noqa: BLE001
            print(f"ERROR   {e['key']}: {doi}: {ex}")
            failures += 1
            continue
        if msg is None:
            print(f"FAIL    {e['key']}: DOI {doi} does not resolve at Crossref (404)")
            failures += 1
            continue
        problems, notes = compare_entry(e, msg)
        for n in notes:
            print(f"NOTE    {e['key']}: {n}")
        if problems:
            failures += 1
            for p in problems:
                print(f"FAIL    {e['key']}: {p}")
        else:
            print(f"OK      {e['key']}: {doi}")
    print(f"{failures} failing entr{'y' if failures == 1 else 'ies'}" if failures else "all DOIs match Crossref")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
