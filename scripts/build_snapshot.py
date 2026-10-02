"""Build a LOCAL development dataset at docs/data/local/french.json (gitignored, never committed or deployed).

Source: the copy of Kenneth R. French Data Library series that ships inside the `linearmodels` Python package
(linearmodels/datasets/french/french.csv.bz2, NCSA-licensed package). It ends in 2017-03 and is an OLDER
VINTAGE than the live library: French revises history when CRSP data are updated, so numbers differ slightly
from today's files. The live, current-vintage data are produced by scripts/fetch_french.py (run in CI).

Known limits of this snapshot (shown in the UI):
- The package does not document whether its 12 industry portfolios are value- or equal-weighted (UNVERIFIED).
- It contains only the corner/middle cells (1, 3, 5) of the 5x5 size/momentum sort, not the 2x3 sort that
  defines the Mom factor, so only a consistency check (not an exact replication) of Mom is possible.

Usage: python scripts/build_snapshot.py
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data" / "local" / "french.json"  # gitignored: never redistributed

INDUSTRIES = ["NoDur", "Durbl", "Manuf", "Enrgy", "Chems", "BusEq", "Telcm", "Utils", "Shops", "Hlth", "Money", "Other"]
INDUSTRY_LABELS = {
    "NoDur": "Consumer non-durables", "Durbl": "Consumer durables", "Manuf": "Manufacturing",
    "Enrgy": "Energy", "Chems": "Chemicals", "BusEq": "Business equipment", "Telcm": "Telecom",
    "Utils": "Utilities", "Shops": "Retail & wholesale", "Hlth": "Healthcare", "Money": "Finance", "Other": "Other",
}
SIZE_MOM = ["S1M1", "S1M3", "S1M5", "S3M1", "S3M3", "S3M5", "S5M1", "S5M3", "S5M5"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    import linearmodels
    from linearmodels.datasets import french

    src = Path(os.path.dirname(linearmodels.__file__)) / "datasets" / "french" / "french.csv.bz2"
    df = french.load()
    dates = [d.strftime("%Y-%m") for d in df["dates"]]
    col = lambda c: [round(float(x), 6) for x in df[c]]  # noqa: E731 (source has 4 decimals of percent)
    market = [round(float(a) + float(b), 6) for a, b in zip(df["MktRF"], df["RF"])]

    data = {
        "schema": 1,
        "id": "french-snapshot-linearmodels-2017",
        "title": "US stock market, 12 industries (French Data Library, 2017 vintage via linearmodels)",
        "frequency": "monthly",
        "periodsPerYear": 12,
        "units": "decimal simple returns",
        "dates": dates,
        "rf": col("RF"),
        "market": market,
        "assets": {name: col(name) for name in INDUSTRIES},
        "assetLabels": INDUSTRY_LABELS,
        "factors": {"MktRF": col("MktRF"), "SMB": col("SMB"), "HML": col("HML"), "Mom": col("Mom")},
        "sizeMomentum5x5Subset": {name: col(name) for name in SIZE_MOM},
        "provenance": {
            "origin": "Kenneth R. French Data Library, https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html",
            "via": f"linearmodels {linearmodels.__version__} package file datasets/french/french.csv.bz2",
            "viaSha256": sha256_file(src),
            "vintage": "older vintage; last month 2017-03; French revises history when CRSP updates",
            "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "caveats": [
                "Industry portfolio weighting (value vs equal) is not documented by the package: UNVERIFIED.",
                "Market = Mkt-RF + RF (the value-weighted CRSP market return used by French).",
                "Local development copy only; redistribution rights for French Library data are unclear, so it is never committed or deployed.",
            ],
            "attribution": "Data courtesy of Kenneth R. French. No license is published on the library site; used with attribution.",
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":"))
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(dates)} months {dates[0]}..{dates[-1]}, {len(text)//1024} KiB")


if __name__ == "__main__":
    main()
