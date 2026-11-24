"""Walk-forward protocol, baselines, evaluation windows and the frozen pass criteria (G3 spec §3-§8).

A *forecaster* is any callable ``f(context: np.ndarray, history: np.ndarray, horizon: int) -> dict``
returning at least ``mean`` and the quantiles ``q10``, ``q30``, ``q50``, ``q90`` for each step of the
horizon (arrays of length ``horizon``). ``context`` is the last ``C`` observations (what TimesFM sees);
``history`` is everything through the origin (what the expanding baselines use). At origin t both end
at observation t, so a forecast for t+1 never sees t+1.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import metrics as M

QUANTILES = (0.1, 0.3, 0.5, 0.9)
QKEYS = ("q10", "q30", "q50", "q90")
BURN_IN = 120          # months before the first forecast origin (spec §3)
PRIMARY_CONTEXT = 512  # months of context for the primary configuration (spec §3; a stated guess)
CONTEXT_GRID = (128, 256, 512, 1024)
SIGNALS = ("mean", "q50", "q30")  # "signal > 0" variants; 4 x 3 = 12 trials for PBO and deflated Sharpe

# Evaluation windows (spec §4). Dates are "YYYY-MM" month labels; a window includes months >= start.
WINDOWS = {
    "A": {"start": "2025-10", "label": "after the TimesFM 2.5 release (2025-09-15): clean by construction"},
    "B": {"start": "2023-12", "label": "after the stated data cutoffs; GiftEvalPretrain composition not verified"},
    "C": {"start": None, "label": "full history: possible pretraining overlap, never a headline"},
}

Forecaster = Callable[[np.ndarray, np.ndarray, int], dict]


# ---------------------------------------------------------------- baselines (spec §5)
def _empirical(history: np.ndarray, horizon: int, centre: float | None = None) -> dict:
    qs = np.quantile(history, QUANTILES)
    if centre is not None:
        qs = qs - np.median(history) + centre
    out = {k: np.full(horizon, float(v)) for k, v in zip(QKEYS, qs)}
    return out


def random_walk(context, history, horizon):
    """Random walk on price: next excess return forecast 0; band from the empirical spread around 0."""
    out = _empirical(np.asarray(history, float), horizon, centre=0.0)
    out["mean"] = np.zeros(horizon)
    return out


def historical_mean(context, history, horizon):
    """Expanding historical mean; band = expanding empirical quantiles (the spec's quantile baseline)."""
    h = np.asarray(history, float)
    out = _empirical(h, horizon)
    out["mean"] = np.full(horizon, float(h.mean()))
    return out


BASELINES: dict[str, Forecaster] = {"random walk": random_walk, "historical mean": historical_mean}


# ---------------------------------------------------------------- walk-forward (spec §3)
@dataclass
class Path:
    name: str
    dates: list[str]                 # month being forecast (t+1)
    actual: np.ndarray
    forecast: dict[str, np.ndarray]  # mean, q10, q30, q50, q90
    meta: dict = field(default_factory=dict)


def walk_forward(dates, series, forecaster: Forecaster, *, name: str, context: int = PRIMARY_CONTEXT,
                 burn_in: int = BURN_IN, horizon: int = 1) -> Path:
    """One-step-ahead forecasts from every origin t >= burn_in - 1. Zero-shot: nothing is refitted."""
    x = np.asarray(series, dtype=float)
    if len(dates) != len(x):
        raise ValueError("dates and series differ in length")
    if not np.all(np.isfinite(x)):
        raise ValueError("series has non-finite values")
    if len(x) <= burn_in:
        raise ValueError("series shorter than the burn-in")
    if horizon != 1:
        raise NotImplementedError("only h = 1 is evaluated in this harness")
    out = {k: [] for k in ("mean",) + QKEYS}
    for t in range(burn_in - 1, len(x) - 1):
        hist = x[: t + 1]
        ctx = hist[-context:]
        f = forecaster(ctx, hist, horizon)
        for k in out:
            v = np.asarray(f[k], dtype=float).reshape(-1)
            if v.shape[0] < horizon or not np.isfinite(v[0]):
                raise ValueError(f"forecaster {name} returned a bad {k} at origin {dates[t]}")
            out[k].append(float(v[0]))
    fc = {k: np.asarray(v) for k, v in out.items()}
    if np.any(fc["q10"] > fc["q90"]):
        raise ValueError(f"forecaster {name} returned crossed quantiles")
    return Path(name=name, dates=list(dates[burn_in:]), actual=x[burn_in:], forecast=fc,
                meta={"context": context, "burnIn": burn_in, "insample": x[:burn_in]})


def window_mask(dates, window: str) -> np.ndarray:
    start = WINDOWS[window]["start"]
    return np.array([True if start is None else d >= start for d in dates])


# ---------------------------------------------------------------- evaluation and pass criteria (spec §6, §8)
def evaluate(model: Path, baselines: dict[str, Path], window: str, *, break_even: float | None) -> dict:
    """Metrics for one window, and the spec's frozen verdicts for the returns, direction and calibration tests.

    break_even: the timing accuracy needed to beat buy-and-hold on the same window and costs (computed by
    breakEvenAccuracy in docs/engine/timing.js). None means "not computed", and the direction test then
    reports "not run" instead of guessing.
    """
    m = window_mask(model.dates, window)
    n = int(m.sum())
    res = {"window": window, "label": WINDOWS[window]["label"], "n": n, "tests": {}}
    if n < 3:
        res["note"] = "fewer than 3 months: nothing can be tested"
        return res
    a = model.actual[m]
    f = model.forecast
    e_model = a - f["mean"][m]
    res["mase"] = M.mase(a, f["mean"][m], model.meta["insample"])
    res["dm"] = {}
    rejects_all = True
    for bname, bp in baselines.items():
        if bp.dates != model.dates:
            raise ValueError(f"baseline {bname} is not aligned with the model")
        e_b = a - bp.forecast["mean"][m]
        dm = M.diebold_mariano(e_model, e_b, loss="squared")
        res["dm"][bname] = {"squared": dm, "absolute": M.diebold_mariano(e_model, e_b, loss="absolute")}
        rejects_all &= bool(np.isfinite(dm["p"]) and dm["p"] < 0.05 and dm["stat"] < 0)
    res["tests"]["returns"] = {
        "pass": bool(window == "B" and rejects_all and res["mase"] < 1),
        "rule": "DM (squared loss) rejects equal loss vs both baselines at 5% in favour of the model, in Window B, and MASE < 1",
        "applies": window == "B",
    }
    da = M.directional_accuracy(a, f["mean"][m])
    res["direction"] = da
    if break_even is None:
        res["tests"]["direction"] = {"pass": None, "rule": "Wilson lower bound > break-even accuracy", "note": "break-even not computed"}
    else:
        res["tests"]["direction"] = {"pass": bool(da["wilson95"][0] > break_even), "breakEven": break_even,
                                     "rule": "Wilson 95% lower bound > break-even accuracy for this window and cost"}
    cov = M.band_coverage(a, f["q10"][m], f["q90"][m])
    pin_model = np.mean([M.pinball(a, f[k][m], tau) for k, tau in zip(QKEYS, QUANTILES)])
    emp = baselines.get("historical mean")
    pin_emp = None if emp is None else np.mean([M.pinball(a, emp.forecast[k][m], tau) for k, tau in zip(QKEYS, QUANTILES)])
    res["calibration"] = {"coverage80": cov, "pinball": float(pin_model), "pinballEmpirical": None if pin_emp is None else float(pin_emp)}
    res["tests"]["calibration"] = {
        "pass": bool(cov["exact95"][0] <= 0.8 <= cov["exact95"][1] and pin_emp is not None and pin_model <= pin_emp),
        "rule": "80% band coverage interval contains 0.80 and mean pinball loss <= the empirical-quantile baseline",
    }
    res["tests"]["volatility"] = {"pass": None, "note": "not run in this harness yet (needs daily data and a GARCH(1,1) baseline)"}
    res["tests"]["timing"] = {"pass": None, "note": "not run in this harness yet (positions go through the JavaScript engine)"}
    return res


def power_note(n: int) -> str:
    """The spec's power note: half-width of a Wilson 95% interval at 50% accuracy for n months."""
    if n <= 0:
        return "no months in this window"
    lo, hi = M.wilson_interval(round(n / 2), n)
    return f"{n} months: a Wilson 95% interval at 50% accuracy spans {lo:.0%} to {hi:.0%}, so only a very large edge could be detected."
