"""Tests for scripts/check_citations.py: offline schema mode and the Crossref comparison rules (no network)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import check_citations as cc  # noqa: E402

GOOD = {
    "key": "jegadeesh1993winners",
    "authors": [{"family": "Jegadeesh", "given": "Narasimhan"}, {"family": "Titman", "given": "Sheridan"}],
    "title": "Returns to Buying Winners and Selling Losers",
    "journal": "The Journal of Finance", "year": 1993, "doi": "10.1111/j.1540-6261.1993.tb04702.x",
    "verification": "crossref",
}


def crossref_msg(**over):
    msg = {
        "title": ["Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency"],
        "subtitle": [],
        "issued": {"date-parts": [[1993, 3]]},
        "published-print": {"date-parts": [[1993, 3]]},
        "author": [{"family": "Jegadeesh", "given": "Narasimhan", "sequence": "first"},
                   {"family": "Titman", "given": "Sheridan", "sequence": "additional"}],
        "container-title": ["The Journal of Finance"],
    }
    msg.update(over)
    return msg


def test_repository_citations_pass_offline():
    assert cc.main(["--offline"]) == 0


def test_offline_schema_errors(tmp_path):
    bad = [
        dict(GOOD),
        dict(GOOD),  # duplicate key
        {**GOOD, "key": "x1", "doi": "https://doi.org/10.1/abc"},
        {**GOOD, "key": "x2", "doi": "10.1/abc"},  # registrant too short
        {k: v for k, v in GOOD.items() if k != "year"} | {"key": "x3"},
        {**GOOD, "key": "x4", "authors": []},
        {**GOOD, "key": "x5", "verification": "trust-me"},
        {**GOOD, "key": "x6", "doi": None, "url": None},
    ]
    errs = cc.validate_schema(bad)
    joined = "\n".join(errs)
    assert "duplicate key" in joined
    assert "malformed DOI 'https://doi.org/10.1/abc'" in joined
    assert "malformed DOI '10.1/abc'" in joined
    assert "missing field 'year'" in joined
    assert "authors must be a non-empty list" in joined
    assert "verification must be one of" in joined
    assert "needs a DOI or a URL" in joined
    # Engine references a key that the file lacks -> reported.
    assert any("used in docs/engine/" in e and "is missing from citations.json" in e for e in errs)
    f = tmp_path / "c.json"
    f.write_text(json.dumps(bad))
    assert cc.main(["--offline", "--file", str(f)]) == 1


def test_title_rules():
    assert cc.title_matches("Returns to Buying Winners and Selling Losers", crossref_msg()["title"], [])
    assert cc.title_matches("Returns to buying winners and selling losers: implications for stock market efficiency", crossref_msg()["title"], [])
    assert cc.title_matches("Pairs Trading: Performance of a Relative-Value Arbitrage Rule", ["Pairs Trading"], ["Performance of a Relative-Value Arbitrage Rule"])
    assert cc.title_matches("Optimal Versus Naive Diversification: How Inefficient is the 1/N Portfolio Strategy?",
                            ["Optimal Versus Naive Diversification: How Inefficient is the 1/<i>N</i> Portfolio Strategy?"], [])
    assert cc.title_matches("Co-Integration and Error Correction", ["Co-Integration and Error Correction: Representation, Estimation, and Testing"], [])
    assert not cc.title_matches("Returns to Buying Winners", crossref_msg()["title"], [])  # not at a separator
    assert not cc.title_matches("Something else entirely", crossref_msg()["title"], [])


def test_compare_entry_ok_and_failures():
    assert cc.compare_entry(GOOD, crossref_msg()) == ([], [])
    errs, notes = cc.compare_entry({**GOOD, "year": 1992}, crossref_msg())
    assert errs == [] and "within 1" in notes[0]
    errs, _ = cc.compare_entry({**GOOD, "year": 1990}, crossref_msg())
    assert "year differs" in errs[0]
    errs, _ = cc.compare_entry({**GOOD, "authors": [{"family": "Titman"}]}, crossref_msg())
    assert "first author differs" in errs[0]
    errs, _ = cc.compare_entry({**GOOD, "journal": "Journal of Financial Economics"}, crossref_msg())
    assert "journal differs" in errs[0]
    # "The" prefix, accents and short container titles are tolerated.
    assert cc.compare_entry({**GOOD, "journal": "Journal of Finance"}, crossref_msg())[0] == []
    assert cc.compare_entry({**GOOD, "authors": [{"family": "Jégadeesh"}]}, crossref_msg())[0] == []
    assert cc.compare_entry({**GOOD, "journal": "Rev. Financ. Stud."},
                            crossref_msg(**{"container-title": ["Review of Financial Studies"], "short-container-title": ["Rev. Financ. Stud."]}))[0] == []
