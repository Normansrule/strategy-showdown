"""Parser and dataset assembly for Kenneth R. French Data Library CSV files (Python twin of the JS loaders).

Mirrors docs/engine/data/french-csv.js (parse_french_csv) and docs/engine/data/loaders.js (classify, assemble,
Mom replication). Both are tested on the same fixtures in tests/fixtures/french/ and must behave identically.
Standard library only.

File layout (checked against copies of real library files; see docs/EVIDENCE_POLICY.md "Data files"):
free-text lines, an optional section title, a column-header line starting with a comma (",Mkt-RF,SMB,HML,RF"),
rows "YYYYMM,  v1,  v2" in PERCENT (annual sections "YYYY"), blank lines, more titled sections, a copyright line.
Missing values are -99.99 or -999. CRLF line endings and trailing spaces in column names occur.
"""
from __future__ import annotations

import hashlib
import io
import re
import zipfile
from datetime import datetime, timezone
from typing import Any

MISSING_CODES = (-99.99, -999.0)
MAX_CSV_CHARS = 50 * 1024 * 1024
MAX_ZIP_UNCOMPRESSED = 50 * 1024 * 1024

FRENCH_BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FRENCH_LIBRARY_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html"
FRENCH_FILES = [
    {"name": "F-F_Research_Data_Factors_CSV.zip", "required": True},
    {"name": "12_Industry_Portfolios_CSV.zip", "required": True},
    {"name": "F-F_Momentum_Factor_CSV.zip", "required": False},
    {"name": "6_Portfolios_ME_Prior_12_2_CSV.zip", "required": False},
]
for _f in FRENCH_FILES:
    _f["url"] = FRENCH_BASE_URL + _f["name"]

ATTRIBUTION = (
    "Data: Kenneth R. French Data Library (Tuck School of Business, Dartmouth). The library publishes no licence; "
    "the data are not redistributed by this project and are used with attribution."
)
INDUSTRY_LABELS = {
    "NoDur": "Consumer non-durables", "Durbl": "Consumer durables", "Manuf": "Manufacturing", "Enrgy": "Energy",
    "Chems": "Chemicals", "BusEq": "Business equipment", "Telcm": "Telecom", "Utils": "Utilities",
    "Shops": "Retail & wholesale", "Hlth": "Healthcare", "Money": "Finance", "Other": "Other",
    "HiTec": "High technology",
}
MOM_REPLICATION_FORMULA = "Mom = ½(Small High + Big High) − ½(Small Low + Big Low)"
SIX_BY_NAME = {"smallLow": "SMALL LoPRIOR", "smallHigh": "SMALL HiPRIOR", "bigLow": "BIG LoPRIOR", "bigHigh": "BIG HiPRIOR"}
SIX_BY_POSITION = {"smallLow": 0, "smallHigh": 2, "bigLow": 3, "bigHigh": 5}

_HEADER_RE = re.compile(r"^\s*,")
_ROW_RE = re.compile(r"^\s*(\d{4}|\d{6}|\d{8})\s*,(.*)$")
_NUM_RE = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_KIND_LABEL = {
    "factors": "Fama/French factors file", "industry": "industry portfolios file",
    "momentum": "momentum factor file", "sizeMomentum6": "6 size/momentum portfolios file",
}


class FrenchDataError(ValueError):
    """User-readable problem with an input file."""


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def _parse_value(cell: str, line_no: int) -> float | None:
    s = cell.strip()
    if s == "":
        return None
    if not _NUM_RE.match(s):
        raise FrenchDataError(f'French CSV line {line_no}: "{s}" is not a number.')
    v = float(s)
    if v in MISSING_CODES:
        return None
    return v


def parse_french_csv(text: str) -> dict[str, Any]:
    """Same contract as parseFrenchCsv in french-csv.js. Values stay in percent; missing -> None."""
    if len(text) > MAX_CSV_CHARS:
        raise FrenchDataError("CSV file is larger than 50 MB; refusing it.")
    if text.startswith("﻿"):
        text = text[1:]
    lines = re.split(r"\r\n|\n|\r", text)
    preamble_lines: list[str] = []
    sections: list[dict[str, Any]] = []
    pending: list[str] = []
    current: dict[str, Any] | None = None
    prev_blank = True

    for i, raw in enumerate(lines):
        line_no = i + 1
        line = raw.rstrip()
        if line.strip() == "":
            prev_blank = True
            continue
        if _HEADER_RE.match(line):
            title = ""
            if not prev_blank and pending:
                title = pending.pop().strip()
            if not sections:
                preamble_lines.extend(pending)
            pending = []
            columns = [c.strip() for c in re.sub(r"^\s*,", "", line).split(",")]
            if any(c == "" for c in columns):
                raise FrenchDataError(f"French CSV line {line_no}: the column header has an empty column name.")
            current = {"title": title, "columns": columns, "rows": [], "ignoredRows": 0}
            sections.append(current)
            prev_blank = False
            continue
        m = _ROW_RE.match(line)
        if m and current is not None and not pending:
            key, rest = m.group(1), m.group(2)
            cells = rest.split(",")
            if len(cells) != len(current["columns"]):
                raise FrenchDataError(
                    f"French CSV line {line_no}: expected {len(current['columns'])} values, found {len(cells)}."
                )
            if len(key) != 6:
                current["ignoredRows"] += 1
                prev_blank = False
                continue
            month = int(key[4:])
            if month < 1 or month > 12:
                raise FrenchDataError(f'French CSV line {line_no}: "{key}" is not a valid YYYYMM month.')
            period = f"{key[:4]}-{key[4:]}"
            if current["rows"] and period <= current["rows"][-1]["period"]:
                raise FrenchDataError(f"French CSV line {line_no}: month {period} is out of order or repeated.")
            current["rows"].append({"period": period, "values": [_parse_value(c, line_no) for c in cells]})
            prev_blank = False
            continue
        if m and current is None:
            raise FrenchDataError(f"French CSV line {line_no}: data row before any column header.")
        if m:
            raise FrenchDataError(f"French CSV line {line_no}: data row after text without a new column header.")
        pending.append(line)
        prev_blank = False

    preamble = "\n".join(l.strip() for l in preamble_lines)
    trailer = "\n".join(l.strip() for l in pending)
    vm = re.search(r"using the (\d{6}) CRSP database", preamble, re.I)
    return {"preamble": preamble, "sections": sections, "trailer": trailer, "vintage": vm.group(1) if vm else None}


# ---------------------------------------------------------------- classification and assembly


def _monthly(parsed):
    return [s for s in parsed["sections"] if s["rows"]]


def _find_section(parsed, pred, what, name):
    for s in _monthly(parsed):
        if pred(s):
            return s
    raise FrenchDataError(f"{name}: could not find the {what} section with monthly rows.")


def _same_cols(a, b):
    return len(a) == len(b) and all(_norm(x) == _norm(y) for x, y in zip(a, b))


def classify_french_file(file_name: str, parsed: dict) -> dict:
    base = file_name.split("/")[-1]
    pre = parsed["preamble"].lower()
    all_s = parsed["sections"]
    if not all_s:
        raise FrenchDataError(
            f"{base}: no column header found; this does not look like a Kenneth R. French Data Library CSV file."
        )
    if not _monthly(parsed):
        raise FrenchDataError(
            f"{base}: no monthly rows (YYYYMM) found. Daily, weekly and annual-only files are not supported; use the monthly file."
        )
    first = [_norm(c) for c in all_s[0]["columns"]]
    vw_monthly = lambda s: re.search(r"value\s*weight", s["title"], re.I) and re.search(r"monthly", s["title"], re.I)  # noqa: E731

    if "mkt-rf" in first:
        if "rmw" in first or "cma" in first:
            raise FrenchDataError(
                f"{base}: this is the 5-factor file. Use F-F_Research_Data_Factors (3 factors), whose SMB is the one the engine expects."
            )
        sec = _find_section(parsed, lambda s: _same_cols(s["columns"], ["Mkt-RF", "SMB", "HML", "RF"]), "Mkt-RF, SMB, HML, RF", base)
        return {"kind": "factors", "section": sec}
    if all(len(s["columns"]) == 1 for s in all_s) and re.match(r"^(mom|umd)$", first[0]):
        sec = _find_section(parsed, lambda s: re.match(r"^(mom|umd)$", _norm(s["columns"][0])), "Mom", base)
        return {"kind": "momentum", "section": sec}
    m1 = re.search(r"(\d+)_industry_portfolios", base, re.I)
    m2 = re.search(r"returns for (\d+) industry portfolios", pre, re.I)
    industry_n = (m1 and m1.group(1)) or (m2 and m2.group(1))
    if industry_n or "industry portfolios" in pre:
        if re.search(r"_daily|_weekly", base, re.I):
            raise FrenchDataError(f"{base}: daily/weekly files are not supported; use the monthly file.")
        sec = _find_section(parsed, vw_monthly, '"Average Value Weighted Returns -- Monthly"', base)
        if industry_n and len(sec["columns"]) != int(industry_n):
            raise FrenchDataError(f"{base}: expected {industry_n} industry columns, found {len(sec['columns'])}.")
        return {"kind": "industry", "section": sec, "nIndustries": len(sec["columns"])}
    is_six = bool(re.search(r"6_portfolios_me_prior_12_2", base, re.I)) or (
        "prior" in pre and re.search(r"-12 to\s*-\s*2", pre) and len(all_s[0]["columns"]) == 6
    )
    if is_six:
        sec = _find_section(parsed, vw_monthly, '"Average Value Weighted Returns -- Monthly"', base)
        if len(sec["columns"]) != 6:
            raise FrenchDataError(f"{base}: expected 6 portfolio columns, found {len(sec['columns'])}.")
        return {"kind": "sizeMomentum6", "section": sec}
    names = ", ".join(f["name"].replace("_CSV.zip", "") for f in FRENCH_FILES)
    raise FrenchDataError(f"{base}: not one of the supported files ({names}, or another N_Industry_Portfolios file).")


def _pearson(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    sab = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    saa = sum((x - ma) ** 2 for x in a)
    sbb = sum((y - mb) ** 2 for y in b)
    return sab / (saa * sbb) ** 0.5


def momentum_replication(six: dict, mom: dict) -> dict:
    mapping = "by-name"
    idx = {}
    for k, col in SIX_BY_NAME.items():
        idx[k] = next((i for i, c in enumerate(six["columns"]) if _norm(c) == _norm(col)), -1)
    if any(i < 0 for i in idx.values()):
        mapping = "positional"
        idx = dict(SIX_BY_POSITION)
    mom_by = {r["period"]: r["values"][0] for r in mom["rows"]}
    rebuilt, published = [], []
    for r in six["rows"]:
        p = mom_by.get(r["period"])
        v = [r["values"][idx[k]] for k in ("smallLow", "smallHigh", "bigLow", "bigHigh")]
        if p is None or any(x is None for x in v):
            continue
        rebuilt.append((0.5 * (v[1] + v[3]) - 0.5 * (v[0] + v[2])) / 100)
        published.append(p / 100)
    if len(rebuilt) < 12:
        return {"available": False, "reason": "Fewer than 12 overlapping months between the six portfolios and Mom."}
    diffs = [abs(a - b) for a, b in zip(rebuilt, published)]
    cols = six["columns"]
    return {
        "available": True,
        "formula": MOM_REPLICATION_FORMULA,
        "source": "French library momentum factor page (det_mom_factor.html)",
        "months": len(rebuilt),
        "maxAbsDiff": max(diffs),
        "meanAbsDiff": sum(diffs) / len(diffs),
        "correlation": _pearson(rebuilt, published),
        "columnMapping": mapping,
        "headerUsed": list(cols),
        "columnsUsed": {k: cols[idx[k]] for k in ("smallLow", "smallHigh", "bigLow", "bigHigh")},
        "units": "decimal returns (0.0001 = 0.01 percentage points)",
        "roundingNote": "The library prints returns to 2 decimals of a percent, so rounding alone can explain differences up to 0.00015 (4 inputs × ½ × 0.00005 + 0.00005).",
    }


def _next_month(p: str) -> str:
    y, m = int(p[:4]), int(p[5:]) + 1
    if m == 13:
        y, m = y + 1, 1
    return f"{y:04d}-{m:02d}"


def assemble_dataset(items: list[dict], now: str | None = None) -> dict:
    """items: [{name, entry, sha256, size, parsed}] -> dataset dict (same as assembleFrenchDataset in loaders.js)."""
    by_kind: dict[str, dict] = {}
    for it in items:
        c = classify_french_file(it.get("entry") or it["name"], it["parsed"])
        if c["kind"] in by_kind:
            raise FrenchDataError(
                f"Two {_KIND_LABEL[c['kind']]}s were given ({by_kind[c['kind']]['item']['name']} and {it['name']}). Add only one."
            )
        c["item"] = it
        by_kind[c["kind"]] = c
    if "factors" not in by_kind:
        raise FrenchDataError("Missing the Fama/French factors file (F-F_Research_Data_Factors_CSV.zip).")
    if "industry" not in by_kind:
        raise FrenchDataError("Missing an industry portfolios file (e.g. 12_Industry_Portfolios_CSV.zip).")

    F = by_kind["factors"]["section"]
    I = by_kind["industry"]["section"]
    M = by_kind["momentum"]["section"] if "momentum" in by_kind else None
    f_by = {r["period"]: r["values"] for r in F["rows"]}
    i_by = {r["period"]: r["values"] for r in I["rows"]}
    m_by = {r["period"]: r["values"][0] for r in M["rows"]} if M else None

    common = [r["period"] for r in F["rows"] if r["period"] in i_by]
    if not common:
        raise FrenchDataError("The factors file and the industry file have no months in common.")
    complete = [p for p in common if None not in f_by[p] and None not in i_by[p]]
    missing_value_months = len(common) - len(complete)
    with_mom = [p for p in complete if m_by.get(p) is not None] if m_by is not None else complete
    momentum_unavailable = len(complete) - len(with_mom)
    best: list[str] = []
    run: list[str] = []
    for p in with_mom:
        if run and _next_month(run[-1]) != p:
            run = []
        run.append(p)
        if len(run) >= len(best):
            best = list(run)
    gap_trimmed = len(with_mom) - len(best)
    if len(best) < 24:
        raise FrenchDataError(
            f"Only {len(best)} complete consecutive months after aligning the files; at least 24 are needed."
        )
    dates = best

    def fc(name):
        return next(i for i, c in enumerate(F["columns"]) if _norm(c) == _norm(name))

    col = lambda by, j: [by[p][j] / 100 for p in dates]  # noqa: E731
    rf = col(f_by, fc("RF"))
    market = [(f_by[p][fc("Mkt-RF")] + f_by[p][fc("RF")]) / 100 for p in dates]
    assets, labels = {}, {}
    for j, name in enumerate(I["columns"]):
        if name in assets:
            raise FrenchDataError(f"Industry file has the column {name} twice.")
        assets[name] = col(i_by, j)
        labels[name] = INDUSTRY_LABELS.get(name, name)
    factors = {"MktRF": col(f_by, fc("Mkt-RF")), "SMB": col(f_by, fc("SMB")), "HML": col(f_by, fc("HML"))}
    if m_by is not None:
        factors["Mom"] = [m_by[p] / 100 for p in dates]

    def record(kind, sections_used, columns):
        it = by_kind[kind]["item"]
        return {"name": it["name"], "entry": it.get("entry"), "sha256": it["sha256"], "bytes": it["size"], "kind": kind,
                "crspVintage": it["parsed"]["vintage"], "sectionsUsed": sections_used, "columns": columns}

    files = [
        record("factors", [F["title"] or "(first, untitled monthly section)"], F["columns"]),
        record("industry", [I["title"]], I["columns"]),
    ]
    if M:
        files.append(record("momentum", [M["title"] or "(first, untitled monthly section)"], M["columns"]))
    replication: dict = {"available": False, "reason": "Needs both the momentum factor file and the 6 size/momentum portfolios file."}
    if "sizeMomentum6" in by_kind:
        six = by_kind["sizeMomentum6"]["section"]
        files.append(record("sizeMomentum6", [six["title"]], six["columns"]))
        if M:
            replication = momentum_replication(six, M)

    vintages: list[str] = []
    for f in files:
        if f["crspVintage"] and f["crspVintage"] not in vintages:
            vintages.append(f["crspVintage"])
    n = len(I["columns"])
    if len(vintages) == 1:
        vlabel = f"CRSP {vintages[0]} vintage"
    elif vintages:
        vlabel = "mixed CRSP vintages " + ", ".join(vintages)
    else:
        vlabel = "vintage not stated in files"
    vintage_note = ("French revises past returns when CRSP data are updated, so results depend on the download date. "
                    "The CRSP vintage is read from each file's first line.")
    if len(vintages) > 1:
        vintage_note += " WARNING: the files come from different vintages; download them on the same day."
    return {
        "schema": 1,
        "id": f"french-{n}ind-{vintages[0] if len(vintages) == 1 else 'user'}",
        "title": f"US stock market, {n} industries (Kenneth R. French Data Library, {vlabel})",
        "frequency": "monthly",
        "periodsPerYear": 12,
        "units": "decimal simple returns",
        "dates": dates, "rf": rf, "market": market, "assets": assets, "assetLabels": labels, "factors": factors,
        "replication": replication,
        "provenance": {
            "origin": f"Kenneth R. French Data Library, {FRENCH_LIBRARY_URL}",
            "files": files,
            "parsedAt": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "weighting": "value-weighted",
            "market": "Market = Mkt-RF + RF (value-weighted return of CRSP firms listed on NYSE, AMEX or NASDAQ).",
            "alignment": {
                "commonMonths": len(common), "missingValueMonths": missing_value_months,
                "momentumUnavailableMonths": momentum_unavailable, "gapTrimmedMonths": gap_trimmed,
                "keptMonths": len(dates), "first": dates[0], "last": dates[-1],
            },
            "droppedMonths": len(common) - len(dates),
            "vintageNote": vintage_note,
            "attribution": ATTRIBUTION,
        },
    }


def read_input(name: str, data: bytes) -> list[dict]:
    """Expand one .zip or .csv into [{name, entry, sha256, size, text}] with the same limits as zip.js."""
    sha = hashlib.sha256(data).hexdigest()
    if data[:4] == b"PK\x03\x04":
        out = []
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            if sum(i.file_size for i in infos) > MAX_ZIP_UNCOMPRESSED:
                raise FrenchDataError(f"{name}: ZIP would expand to more than 50 MB; refusing it.")
            for info in infos:
                n = info.filename
                if n.startswith("/") or "\\" in n or any(seg in ("..", ".") for seg in n.split("/")):
                    raise FrenchDataError(f"{name}: unsafe path in ZIP entry {n!r}.")
                if info.flag_bits & 0x1:
                    raise FrenchDataError(f"{name}: ZIP entry {n!r} is encrypted; not supported.")
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise FrenchDataError(f"{name}: ZIP entry {n!r} uses an unsupported compression method.")
                if not n.lower().endswith(".csv"):
                    continue
                raw = zf.read(info)
                out.append({"name": name, "entry": n, "sha256": sha, "size": len(data),
                            "text": raw.decode("utf-8", errors="replace")})
        if not out:
            raise FrenchDataError(f"{name}: the ZIP contains no .csv file.")
        return out
    return [{"name": name, "entry": None, "sha256": sha, "size": len(data), "text": data.decode("utf-8", errors="replace")}]


def load_french_files(files: list[tuple[str, bytes]], now: str | None = None) -> dict:
    items = []
    for name, data in files:
        for e in read_input(name, data):
            try:
                parsed = parse_french_csv(e["text"])
            except FrenchDataError as err:
                raise FrenchDataError(f"{e['entry'] or e['name']}: {err}") from None
            items.append({**{k: v for k, v in e.items() if k != "text"}, "parsed": parsed})
    return assemble_dataset(items, now=now)
