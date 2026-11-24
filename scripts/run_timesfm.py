#!/usr/bin/env python3
"""Run the G3 walk-forward evaluation on a dataset JSON (the same format the site uses) and print, or save, a
summary: per-window metrics and the spec's frozen verdicts, plus the input SHA-256 and the versions used.

    # Baselines only, no model needed (any machine):
    python scripts/run_timesfm.py --data tests/fixtures/crosscheck-dataset.json --model historical-mean

    # TimesFM 2.5 (local only; downloads the pinned Apache-2.0 weights once):
    pip install "timesfm[torch]==2.0.2"
    python scripts/run_timesfm.py --data docs/data/local/french.json --model timesfm-2.5 --out results.json

Never commit real-data inputs or per-month forecasts: only the printed summary (spec §7). TimesFM 3.0 is refused.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from timesfm_eval import protocol as P  # noqa: E402


def load(path: Path):
    raw = path.read_bytes()
    d = json.loads(raw)
    dates = d["dates"]
    excess = np.log1p(np.asarray(d["market"], float)) - np.log1p(np.asarray(d["rf"], float))
    return dates, excess, hashlib.sha256(raw).hexdigest(), bool(d.get("synthetic"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--model", default="historical-mean", choices=["historical-mean", "timesfm-2.5"])
    ap.add_argument("--context", type=int, default=P.PRIMARY_CONTEXT, choices=P.CONTEXT_GRID)
    ap.add_argument("--break-even", type=float, default=None, help="break-even timing accuracy for the window, from the site's timing engine")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)

    dates, x, sha, synthetic = load(a.data)
    if a.model == "timesfm-2.5":
        from timesfm_eval.model import make_forecaster  # noqa: PLC0415
        fc = make_forecaster(max_context=max(a.context, 128))
    else:
        fc = P.historical_mean
    model = P.walk_forward(dates, x, fc, name=a.model, context=a.context)
    base = {k: P.walk_forward(dates, x, f, name=k, context=a.context) for k, f in P.BASELINES.items()}
    out = {
        "input": {"file": a.data.name, "sha256": sha, "synthetic": synthetic, "months": len(dates), "first": dates[0], "last": dates[-1]},
        "model": a.model, "context": a.context, "burnIn": P.BURN_IN,
        "versions": {"python": platform.python_version(), "numpy": np.__version__},
        "windows": {w: P.evaluate(model, base, w, break_even=a.break_even) for w in P.WINDOWS},
    }
    for w, r in out["windows"].items():
        r["powerNote"] = P.power_note(r["n"])
    text = json.dumps(out, indent=1, default=float)
    if a.out:
        a.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
