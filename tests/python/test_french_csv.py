"""Tests for scripts/french_csv.py and scripts/fetch_french.py --offline, on tests/fixtures/french/
(format fixtures written for tests, values invented)."""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures" / "french"
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_french  # noqa: E402
import french_csv as fc  # noqa: E402

ALL_ZIPS = [
    "F-F_Research_Data_Factors_CSV.zip", "12_Industry_Portfolios_CSV.zip",
    "F-F_Momentum_Factor_CSV.zip", "6_Portfolios_ME_Prior_12_2_CSV.zip",
]
NOW = "2026-09-30T00:00:00.000Z"


def text(name):
    return (FIX / name).read_bytes().decode("latin-1")  # keep CRLF as-is


def load(names):
    return fc.load_french_files([(n, (FIX / n).read_bytes()) for n in names], now=NOW)


def test_factors_layout():
    p = fc.parse_french_csv(text("F-F_Research_Data_Factors.CSV"))
    assert p["vintage"] == "209912"
    assert [s["title"] for s in p["sections"]] == ["", "Annual Factors: January-December"]
    s0 = p["sections"][0]
    assert s0["columns"] == ["Mkt-RF", "SMB", "HML", "RF"]
    assert len(s0["rows"]) == 39 and s0["rows"][0]["period"] == "1999-10"
    assert p["sections"][1]["rows"] == [] and p["sections"][1]["ignoredRows"] == 3
    assert p["trailer"].startswith("Copyright 2099")


def test_industry_sections_and_missing_codes():
    p = fc.parse_french_csv(text("12_Industry_Portfolios.CSV"))
    titles = [s["title"] for s in p["sections"]]
    assert titles[0] == "Average Value Weighted Returns -- Monthly"
    assert "Average Value Weighted Returns -- Annual" in titles
    vw = p["sections"][0]
    assert vw["columns"][0] == "NoDur"
    assert vw["rows"][0]["values"][4] is None  # -99.99
    ew = p["sections"][1]
    assert next(r for r in ew["rows"] if r["period"] == "2001-05")["values"][0] is None  # -999


def test_crlf_equals_lf_and_errors():
    lf = "Header\n\n  Title -- Monthly\n,A,B \n200001, 1.00, -99.99\n200002, 2.50,-999\n\n  Annual\n,A,B\n2000, 1, 2\n"
    assert fc.parse_french_csv(lf) == fc.parse_french_csv(lf.replace("\n", "\r\n"))
    assert fc.parse_french_csv(lf)["sections"][0]["rows"] == [
        {"period": "2000-01", "values": [1.0, None]}, {"period": "2000-02", "values": [2.5, None]},
    ]
    for bad, msg in [
        (",A,B\n200001, 1.0\n", "expected 2 values"),
        (",A\n200001, abc\n", "is not a number"),
        (",A\n200013, 1\n", "not a valid YYYYMM"),
        (",A\n200002, 1\n200001, 1\n", "out of order"),
        ("200001, 1\n", "before any column header"),
        (",A\n200001, 1\nsome text\n200002, 1\n", "without a new column header"),
    ]:
        with pytest.raises(fc.FrenchDataError, match=msg):
            fc.parse_french_csv(bad)


def test_assembly_known_answers():
    ds = load(ALL_ZIPS)
    assert ds["dates"][0] == "2000-02" and ds["dates"][-1] == "2002-11" and len(ds["dates"]) == 34
    assert ds["provenance"]["alignment"] == {
        "commonMonths": 36, "missingValueMonths": 1, "momentumUnavailableMonths": 1, "gapTrimmedMonths": 0,
        "keptMonths": 34, "first": "2000-02", "last": "2002-11",
    }
    assert list(ds["factors"]) == ["MktRF", "SMB", "HML", "Mom"]
    assert len(ds["assets"]) == 12
    i = ds["dates"].index("2001-06")
    raw = next(r for r in fc.parse_french_csv(text("F-F_Research_Data_Factors.CSV"))["sections"][0]["rows"] if r["period"] == "2001-06")["values"]
    assert ds["market"][i] == pytest.approx((raw[0] + raw[3]) / 100, abs=1e-15)
    assert ds["rf"][i] == pytest.approx(raw[3] / 100, abs=1e-15)
    rep = ds["replication"]
    assert rep["available"] and rep["months"] == 36 and rep["maxAbsDiff"] < 1e-12 and rep["correlation"] > 0.999999
    assert rep["columnMapping"] == "by-name"


def test_positional_fallback_and_planted_error():
    rows = []
    for k in range(24):
        rows.append({"period": f"{2001 + k // 12}-{k % 12 + 1:02d}", "values": [k, 0, 2 * k + 1, -k, 0, 3]})
    six = {"columns": ["P1", "P2", "P3", "P4", "P5", "P6"], "rows": rows}
    mom = {"columns": ["Mom"], "rows": [{"period": r["period"], "values": [k + 2 + (0.5 if k == 5 else 0)]} for k, r in enumerate(rows)]}
    res = fc.momentum_replication(six, mom)
    assert res["columnMapping"] == "positional" and res["months"] == 24
    assert res["maxAbsDiff"] == pytest.approx(0.005, abs=1e-15)


def test_missing_required_files():
    with pytest.raises(fc.FrenchDataError, match="Missing the Fama/French factors file"):
        load(["12_Industry_Portfolios_CSV.zip"])
    with pytest.raises(fc.FrenchDataError, match="Missing an industry portfolios file"):
        load(["F-F_Research_Data_Factors_CSV.zip"])


def test_zip_guards():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("../evil.csv", "x")
    with pytest.raises(fc.FrenchDataError, match="unsafe path"):
        fc.read_input("evil.zip", b.getvalue())


def test_fetch_offline_writes_dataset(tmp_path):
    out = tmp_path / "french.json"
    assert fetch_french.main(["--offline", str(FIX), "--out", str(out)]) == 0
    ds = json.loads(out.read_text())
    assert ds["schema"] == 1 and len(ds["dates"]) == 34
    assert ds["provenance"]["builtBy"].endswith("--offline")
    assert ds["replication"]["available"]


def test_fetch_refuses_foreign_urls():
    with pytest.raises(ValueError, match="unexpected URL"):
        fetch_french.download("https://example.com/F-F_Research_Data_Factors_CSV.zip")


def test_replication_gate(tmp_path):
    out = tmp_path / "french.json"
    assert fetch_french.main(["--offline", str(FIX), "--out", str(out), "--check-replication"]) == 0
    ds = json.loads(out.read_text())
    assert fetch_french.check_replication(ds) == []
    ds["replication"]["maxAbsDiff"] = 0.0002
    assert "max |rebuilt" in fetch_french.check_replication(ds)[0]
    assert fetch_french.check_replication({"replication": {"available": False, "reason": "x"}})[0].startswith("replication not available")
