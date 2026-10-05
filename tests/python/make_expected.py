"""Run the independent Python reference on the synthetic fixtures and write expected outputs.

    python3 tests/python/make_expected.py            # regenerate tests/fixtures/expected-*.json and mathx-expected.json
    python3 tests/python/make_expected.py --dataset PATH --config NAME   # print one run as JSON to stdout
                                                    # (used by the JS test for the optional local French data)

Parameter names in CONFIGS use the JavaScript engine's names (the fixture is shared); PARAM_MAP translates them
to the spec's names used by reference.py.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference as R  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
ALL = ["buy-hold-market", "equal-weight", "faber-sma", "tsmom", "xs-momentum", "st-reversal", "mean-variance"]

# JS param name -> spec param name (only where they differ)
PARAM_MAP = {"tsmom": {"lookback": "k", "targetVol": "target"}}

CONFIGS = {
    "defaults-realistic": {"specs": [{"id": s, "params": {}} for s in ALL], "costs": "realistic"},
    "defaults-naive": {"specs": [{"id": s, "params": {}} for s in ALL], "costs": "naive"},
    "window-realistic": {"specs": [{"id": s, "params": {}} for s in ALL], "costs": "realistic",
                         "start": "2001-07", "end": "2012-12"},
    "nondefault-realistic": {
        "specs": [
            {"id": "buy-hold-market", "params": {}},
            {"id": "equal-weight", "params": {}},
            {"id": "faber-sma", "params": {"L": 5}},
            {"id": "tsmom", "params": {"lookback": 6}},
            {"id": "xs-momentum", "params": {"J": 11, "K": 1, "skip": 1}},
            {"id": "st-reversal", "params": {"n": 2}},
            {"id": "mean-variance", "params": {"M": 60}},
        ],
        "costs": "realistic",
    },
    "nondefault-naive-trials": {
        "specs": [
            {"id": "buy-hold-market", "params": {}},
            {"id": "tsmom", "params": {"lookback": 6, "targetVol": 0.2, "com": 6}},
            {"id": "xs-momentum", "params": {"J": 3, "K": 3, "n": 2}},
            {"id": "mean-variance", "params": {"M": 60}},
        ],
        "costs": "naive",
        # explicit trial list (replaces the shown runs' SRs, as the engine's `trials` option does)
        "trials": [0.05, 0.12, -0.03, 0.2, 0.08, 0.15, 0.01],
    },
    "inverse-vol-realistic": {
        "specs": [
            {"id": "buy-hold-market", "params": {}},
            {"id": "equal-weight", "params": {}},
            {"id": "inverse-vol", "params": {}},
            {"id": "inverse-vol", "params": {"M": 12}},
        ],
        "costs": "realistic",
    },
    "pairs-realistic": {
        "specs": [
            {"id": "buy-hold-market", "params": {}},
            {"id": "ggr-pairs", "params": {}},
            {"id": "ggr-pairs", "params": {"F": 24, "Tr": 3, "n": 3, "k": 1.5}},
            {"id": "ggr-pairs", "params": {"F": 6, "Tr": 12, "n": 10, "k": 0.75}},
        ],
        "costs": "realistic",
    },
}

# PBO / CSCV cross-check: sweeps run by each implementation's own engine, then CSCV on the trial matrix.
PBO_CONFIGS = [
    {"name": "faber-L2-13-S8", "id": "faber-sma", "params": [{"L": L} for L in range(2, 14)], "S": 8},
    {"name": "faber-L2-13-S10", "id": "faber-sma", "params": [{"L": L} for L in range(2, 14)], "S": 10},
    {"name": "faber-L2-13-S16", "id": "faber-sma", "params": [{"L": L} for L in range(2, 14)], "S": 16},
    {"name": "pairs-k-S6", "id": "ggr-pairs", "params": [{"k": k} for k in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)], "S": 6},
]

FIXTURE_CONFIGS = {
    "crosscheck": ["defaults-realistic", "defaults-naive", "window-realistic", "nondefault-realistic",
                   "nondefault-naive-trials", "pairs-realistic", "inverse-vol-realistic"],
    "stress": ["defaults-realistic", "nondefault-realistic", "pairs-realistic", "inverse-vol-realistic"],
    "singular": ["nondefault-realistic"],
}


def to_spec_params(sid: str, params: dict) -> dict:
    m = PARAM_MAP.get(sid, {})
    return {m.get(k, k): v for k, v in params.items()}


def jnum(x):
    """JSON-safe number: +/-inf and nan become strings."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    return x


def jlist(a):
    return [jnum(v) for v in np.asarray(a, float).ravel()]


def run_config(ds: dict, cfg: dict) -> dict:
    specs = [(s["id"], to_spec_params(s["id"], s["params"])) for s in cfg["specs"]]
    res = R.compare(ds, specs, R.COST_PRESETS[cfg["costs"]], cfg.get("start"), cfg.get("end"),
                    trials=cfg.get("trials"))
    runs = []
    for r in res["runs"]:
        m = r["metrics"]
        runs.append({
            "id": r["id"],
            "dates": r["dates"],
            "net": jlist(r["net"]),
            "excessNet": jlist(r["excessNet"]),
            "grossExcess": jlist(r["grossExcess"]),
            "turnover": jlist(r["turnover"]),
            "grossExposure": jlist(r["grossExposure"]),
            "netExposure": jlist(r["netExposure"]),
            "ruinedAt": r["ruinedAt"],
            "metrics": {k: (jlist(v) if isinstance(v, list) else jnum(v)) for k, v in m.items()},
            "deflatedSharpe": None if r["dsr"] is None else jnum(r["dsr"]["dsr"]),
            "sr0": None if r["dsr"] is None else jnum(r["dsr"]["sr0"]),
            "test": None if r["vsBenchmark"] is None else {k: jnum(v) for k, v in r["vsBenchmark"].items()},
            "attribution": None if r["attribution"] is None else {
                "names": r["attribution"]["names"], "beta": jlist(r["attribution"]["beta"]),
                "se": jlist(r["attribution"]["se"]), "r2": jnum(r["attribution"]["r2"]),
                "lags": r["attribution"]["lags"]},
        })
    w = res["window"]
    return {
        "config": cfg,
        "fingerprint": res["fingerprint"],
        "window": {"firstEval": w["firstEval"], "endIdx": w["endIdx"], "binding": w["binding"]},
        "conditions": {"evalStart": w["evalStart"], "evalEnd": w["evalEnd"]},
        "correlation": [jlist(row) for row in res["correlation"]],
        "runs": runs,
    }


def mathx_expected() -> dict:
    rng = np.random.default_rng(12345)
    xs = [-8.5, -6, -3.2, -2, -1.2, -0.5, -1e-3, 0, 1e-3, 0.3, 1, 1.959963984540054, 2.5, 4, 6.5, 9]
    ps = [1e-12, 1e-6, 0.001, 0.01, 0.02425, 0.025, 0.1, 0.3, 0.5, 0.7, 0.95, 0.975, 0.99, 0.999, 1 - 1e-6]
    samples = {
        "normal200": np.round(rng.standard_normal(200), 12).tolist(),
        "t4_150": np.round(rng.standard_t(4, 150) * 0.03, 12).tolist(),
        "skewed60": np.round(np.exp(rng.standard_normal(60) * 0.5) - 1, 12).tolist(),
    }
    moments = {}
    for name, x in samples.items():
        a = np.asarray(x)
        moments[name] = {
            "x": x,
            "mean": float(a.mean()),
            "variance": float(a.var(ddof=1)),
            "skewness": R.skewness(a),
            "kurtosisRaw": R.kurtosis_raw(a),
            "autocorr": [R.autocorr(a, k) for k in range(1, 12)],
        }
    mats = []
    for n in (2, 4, 7):
        A = rng.standard_normal((n, n)) + n * np.eye(n) * 0.5
        b = rng.standard_normal(n)
        mats.append({"A": A.tolist(), "b": b.tolist(), "inv": np.linalg.inv(A).tolist(),
                     "x": np.linalg.solve(A, b).tolist(), "cond": float(np.linalg.cond(A))})
    return {
        "generator": "tests/python/make_expected.py (scipy.stats.norm, numpy.linalg)",
        "normCdf": [[x, float(stats.norm.cdf(x))] for x in xs],
        "normInv": [[p, float(stats.norm.ppf(p))] for p in ps],
        "moments": moments,
        "linalg": mats,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset")
    ap.add_argument("--config")
    a = ap.parse_args()
    if a.dataset:
        ds = json.loads(Path(a.dataset).read_text())
        json.dump(run_config(ds, CONFIGS[a.config]), sys.stdout, allow_nan=False)
        return
    for fx, names in FIXTURE_CONFIGS.items():
        ds = json.loads((FIXTURES / f"{fx}-dataset.json").read_text())
        out = {"note": "Expected values from the independent Python reference (tests/python/reference.py). "
                       "Regenerate with: python3 tests/python/make_expected.py",
               "dataset": f"{fx}-dataset.json",
               "runs": {n: run_config(ds, CONFIGS[n]) for n in names}}
        p = FIXTURES / f"expected-{fx}.json"
        p.write_text(json.dumps(out, allow_nan=False) + "\n")
        print("wrote", p)
    ds = json.loads((FIXTURES / "crosscheck-dataset.json").read_text())
    pbo = []
    for c in PBO_CONFIGS:
        specs = [(c["id"], to_spec_params(c["id"], pp)) for pp in c["params"]]
        res = R.compare(ds, specs, R.COST_PRESETS["realistic"])
        M = np.column_stack([np.asarray(r["excessNet"], float) for r in res["runs"]])
        out = R.cscv(M, c["S"])
        pbo.append({"config": c, "T": int(M.shape[0]), **{k: (jlist(v) if isinstance(v, list) else jnum(v)) for k, v in out.items()}})
    p = FIXTURES / "expected-pbo.json"
    p.write_text(json.dumps({"note": "CSCV (spec §8) by the Python reference on its own sweeps of crosscheck-dataset.json, realistic costs.",
                             "cases": pbo}, allow_nan=False) + "\n")
    print("wrote", p)
    p = FIXTURES / "mathx-expected.json"
    p.write_text(json.dumps(mathx_expected(), allow_nan=False, indent=1) + "\n")
    print("wrote", p)


if __name__ == "__main__":
    main()
