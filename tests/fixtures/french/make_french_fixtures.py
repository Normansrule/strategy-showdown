"""Write the French Data Library FORMAT fixtures used by tests/js/loaders.test.mjs and tests/python/test_french_csv.py.

These are format fixtures written for tests; the VALUES ARE INVENTED (seeded random numbers). They mirror the
layout of real library files (description lines, titled sections, a comma-first header, YYYYMM rows in percent,
annual YYYY rows, -99.99/-999 missing codes, CRLF endings, trailing spaces in column names, a copyright line).
They are not market data and are not derived from French library data.

    python3 tests/fixtures/french/make_french_fixtures.py

Output is deterministic (fixed seed, fixed ZIP timestamps), so re-running produces byte-identical files.
Known answers built into the fixtures (asserted by the tests):
  - common months of factors and industries: 2000-01 .. 2002-12 (36)
  - industry file has -99.99 in 2000-01 -> that month is dropped (missingValueMonths = 1)
  - Mom has -99.99 in 2002-12 -> dropped when Mom is supplied (momentumUnavailableMonths = 1)
  - Mom equals ½(SMALL HiPRIOR + BIG HiPRIOR) − ½(SMALL LoPRIOR + BIG LoPRIOR) EXACTLY in every month
"""
from __future__ import annotations

import random
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXED_TIME = (2026, 9, 1, 0, 0, 0)
INDUSTRIES = ["NoDur", "Durbl", "Manuf", "Enrgy", "Chems", "BusEq", "Telcm", "Utils", "Shops", "Hlth", "Money", "Other"]
SIX = ["SMALL LoPRIOR", "ME1 PRIOR2", "SMALL HiPRIOR", "BIG LoPRIOR", "ME2 PRIOR2", "BIG HiPRIOR"]


def months(y0, m0, y1, m1):
    out = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        out.append(f"{y:04d}{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def fmt(v, width=8):
    return f"{v:{width}.2f}"


def row(key, values, width=8):
    return f"{key}," + ",".join(fmt(v, width) for v in values)


def write(path: Path, lines: list[str], crlf: bool):
    nl = "\r\n" if crlf else "\n"
    path.write_bytes((nl.join(lines) + nl).encode("ascii"))


def zip_one(zip_path: Path, member: str, data: bytes, method: int):
    info = zipfile.ZipInfo(member, date_time=FIXED_TIME)
    info.compress_type = method
    info.external_attr = 0o644 << 16
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(info, data)


def main():
    rng = random.Random(20260930)
    r2 = lambda lo, hi: round(rng.uniform(lo, hi), 2)  # noqa: E731

    # ---------------- factors: 1999-10 .. 2002-12 monthly, plus annual section. CRLF.
    fm = months(1999, 10, 2002, 12)
    lines = [
        "This file was created by CMPT_ME_BEME_RETS using the 209912 CRSP database.",
        "FORMAT FIXTURE FOR TESTS - VALUES INVENTED, NOT MARKET DATA.",
        "The 1-month TBill rate data until 202405 are from Ibbotson Associates.",
        "",
        ",Mkt-RF,SMB,HML,RF",
    ]
    for k in fm:
        lines.append(row(k, [r2(-8, 8), r2(-4, 4), r2(-4, 4), r2(0.1, 0.6)]))
    lines += ["", " Annual Factors: January-December ", ",Mkt-RF,SMB,HML,RF"]
    for y in (2000, 2001, 2002):
        lines.append(f"  {y}," + ",".join(fmt(v) for v in [r2(-20, 20), r2(-9, 9), r2(-9, 9), r2(1, 6)]))
    lines += ["", "Copyright 2099 Eugene F. Fama and Kenneth R. French"]
    write(HERE / "F-F_Research_Data_Factors.CSV", lines, crlf=True)

    # ---------------- 12 industries: 2000-01 .. 2002-12. VW monthly has -99.99 in 2000-01 (Chems). CRLF,
    # trailing spaces in the column names, extra monthly sections (EW returns, number of firms, firm size).
    im = months(2000, 1, 2002, 12)
    head = "," + ",".join(f"{n}  " if i % 3 == 0 else n for i, n in enumerate(INDUSTRIES))
    lines = [
        "This file was created using the 209912 CRSP database.",
        "It contains value- and equal-weighted returns for 12 industry portfolios.",
        "FORMAT FIXTURE FOR TESTS - VALUES INVENTED, NOT MARKET DATA.",
        "",
        "The portfolios are constructed at the end of June.",
        "",
        "The annual returns are from January to December.",
        "",
        "Missing data are indicated by -99.99 or -999.",
        "",
        "",
        "  Average Value Weighted Returns -- Monthly",
        head,
    ]
    for k in im:
        vals = [r2(-10, 10) for _ in INDUSTRIES]
        if k == "200001":
            vals[4] = -99.99
        lines.append(row(k, vals))
    lines += ["", "", "  Average Equal Weighted Returns -- Monthly", head]
    for k in im:
        vals = [r2(-12, 12) for _ in INDUSTRIES]
        if k == "200105":
            vals[0] = -999
        lines.append(row(k, vals))
    lines += ["", "", "  Average Value Weighted Returns -- Annual", head]
    for y in (2000, 2001, 2002):
        lines.append(f"  {y}," + ",".join(fmt(r2(-30, 30)) for _ in INDUSTRIES))
    lines += ["", "", "  Number of Firms in Portfolios", head]
    for k in im:
        lines.append(f"{k}," + ",".join(f"{rng.randint(50, 900):8d}" for _ in INDUSTRIES))
    lines += ["", "", "  Average Firm Size", head]
    for k in im:
        lines.append(row(k, [r2(100, 9000) for _ in INDUSTRIES], width=10))
    lines += ["", "Copyright 2099 Eugene F. Fama and Kenneth R. French"]
    write(HERE / "12_Industry_Portfolios.CSV", lines, crlf=True)

    # ---------------- six size/prior portfolios 1999-12 .. 2002-12 (LF endings), and Mom built from them EXACTLY.
    sm = months(1999, 12, 2002, 12)
    six_rows, mom_rows = [], []
    for k in sm:
        sl, bl = r2(-10, 10), r2(-10, 10)
        sh = r2(-10, 10)
        bh = r2(-10, 10)
        # make (sh + bh − sl − bl) an even number of cents so ½ of it is exact at 2 decimals
        if round((sh + bh - sl - bl) * 100) % 2:
            bh = round(bh + 0.01, 2)
        six_rows.append((k, [sl, r2(-10, 10), sh, bl, r2(-10, 10), bh]))
        mom_rows.append((k, round(0.5 * (sh + bh) - 0.5 * (sl + bl), 2)))
    lines = [
        "This file was created by CMPT_ME_PRIOR_RETS using the 209912 CRSP database.",
        "It contains value- weighted returns for the intersections of  2 ME portfolios",
        "and  3 prior return portfolios.",
        "FORMAT FIXTURE FOR TESTS - VALUES INVENTED, NOT MARKET DATA.",
        "",
        "The portfolios are constructed monthly.  ME is market cap at the end of the",
        "previous month.  PRIOR_RET is from -12 to - 2.",
        "",
        "Missing data are indicated by -99.99 or -999.",
        "",
        "",
        "  Average Value Weighted Returns -- Monthly",
        "," + ",".join(SIX),
    ]
    lines += [row(k, v) for k, v in six_rows]
    lines += ["", "", "  Average Equal Weighted Returns -- Monthly", "," + ",".join(SIX)]
    lines += [row(k, [r2(-10, 10) for _ in SIX]) for k in sm]
    lines += ["", "", "  Average Value Weighted Returns -- Annual", "," + ",".join(SIX)]
    lines += [f"  {y}," + ",".join(fmt(r2(-30, 30)) for _ in SIX) for y in (2000, 2001, 2002)]
    lines += ["", "Copyright 2099 Eugene F. Fama and Kenneth R. French"]
    write(HERE / "6_Portfolios_ME_Prior_12_2.CSV", lines, crlf=False)

    # ---------------- Mom. The real file's layout could NOT be inspected from this environment; this mirrors the
    # factors file (description, comma-first header, annual section). Header "Mom" with trailing spaces.
    lines = [
        "This file was created by CMPT_ME_PRIOR_RETS using the 209912 CRSP database.",
        "It contains a momentum factor, constructed from six value-weight portfolios formed using",
        "independent sorts on size and prior return of NYSE, AMEX, and NASDAQ stocks.",
        "FORMAT FIXTURE FOR TESTS - VALUES INVENTED, NOT MARKET DATA.",
        "Missing data are indicated by -99.99 or -999.",
        "",
        ",Mom   ",
    ]
    for k, v in mom_rows:
        lines.append(f"{k}," + fmt(-99.99 if k == "200212" else v))
    lines += ["", " Annual Factors: January-December ", ",Mom   "]
    lines += [f"  {y}," + fmt(r2(-20, 20)) for y in (2000, 2001, 2002)]
    lines += ["", "Copyright 2099 Eugene F. Fama and Kenneth R. French"]
    write(HERE / "F-F_Momentum_Factor.CSV", lines, crlf=True)

    # ---------------- zips (deflate and stored, so both methods are exercised)
    for csv_name, zip_name, method in [
        ("F-F_Research_Data_Factors.CSV", "F-F_Research_Data_Factors_CSV.zip", zipfile.ZIP_DEFLATED),
        ("12_Industry_Portfolios.CSV", "12_Industry_Portfolios_CSV.zip", zipfile.ZIP_DEFLATED),
        ("F-F_Momentum_Factor.CSV", "F-F_Momentum_Factor_CSV.zip", zipfile.ZIP_STORED),
        ("6_Portfolios_ME_Prior_12_2.CSV", "6_Portfolios_ME_Prior_12_2_CSV.zip", zipfile.ZIP_DEFLATED),
    ]:
        zip_one(HERE / zip_name, csv_name, (HERE / csv_name).read_bytes(), method)
    print("wrote fixtures to", HERE)


if __name__ == "__main__":
    main()
