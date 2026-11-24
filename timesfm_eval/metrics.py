"""Forecast-evaluation metrics, each written from its published definition.

* MASE: Hyndman & Koehler (2006), "Another look at measures of forecast accuracy", IJF 22(4).
  Scale = in-sample mean absolute one-step naive error.
* Diebold-Mariano (1995) test of equal predictive accuracy, with a Newey-West (1987) Bartlett HAC
  variance and the Harvey, Leybourne & Newbold (1997) small-sample correction, compared with
  Student t(T-1).
* Wilson (1927) score interval for a binomial proportion.
* Clopper-Pearson exact interval for band coverage.
* QLIKE: Patton (2011), "Volatility forecast comparison using imperfect volatility proxies",
  J. Econometrics 160(1): L = rv/f - log(rv/f) - 1.
* Pinball (quantile) loss: Koenker & Bassett (1978).

All inputs are 1-D float arrays of equal length; NaNs are not allowed (the caller aligns windows).
"""
from __future__ import annotations

import math

import numpy as np
from scipy import stats


def _arr(x) -> np.ndarray:
    a = np.asarray(x, dtype=float)
    if a.ndim != 1:
        raise ValueError("expected a 1-D array")
    if not np.all(np.isfinite(a)):
        raise ValueError("non-finite value")
    return a


def mase(actual, forecast, insample) -> float:
    """Mean absolute scaled error; < 1 means better than the in-sample one-step naive forecast."""
    a, f, x = _arr(actual), _arr(forecast), _arr(insample)
    if len(a) != len(f) or len(a) == 0:
        raise ValueError("actual and forecast must be non-empty and the same length")
    if len(x) < 2:
        raise ValueError("in-sample series needs at least two points")
    scale = np.mean(np.abs(np.diff(x)))
    if scale == 0:
        raise ValueError("in-sample series is constant; MASE undefined")
    return float(np.mean(np.abs(a - f)) / scale)


def bartlett_lag(T: int) -> int:
    """Newey-West rule-of-thumb truncation lag, floor(4 (T/100)^(2/9)); same rule as docs/engine/mathx.js."""
    return int(math.floor(4 * (T / 100) ** (2 / 9)))


def newey_west_var_of_mean(d, lags: int) -> float:
    """HAC (Bartlett kernel) long-run variance of d, divided by T: the variance of mean(d)."""
    d = _arr(d)
    T = len(d)
    u = d - d.mean()
    gamma0 = float(u @ u) / T
    s = gamma0
    for k in range(1, lags + 1):
        w = 1 - k / (lags + 1)
        s += 2 * w * float(u[k:] @ u[:-k]) / T
    return s / T


def diebold_mariano(e1, e2, loss: str = "squared", h: int = 1, lags: int | None = None) -> dict:
    """DM test of H0: E[L(e1)] = E[L(e2)]. Negative statistic: model 1 has lower loss.

    Returns the HLN-corrected statistic, the two-sided p-value from t(T-1), the mean loss
    differential and the lag used. lags defaults to max(h-1, Bartlett rule of thumb).
    """
    e1, e2 = _arr(e1), _arr(e2)
    if len(e1) != len(e2):
        raise ValueError("error series must be the same length")
    T = len(e1)
    if T < 3:
        raise ValueError("need at least 3 forecast errors")
    if loss == "squared":
        d = e1 ** 2 - e2 ** 2
    elif loss == "absolute":
        d = np.abs(e1) - np.abs(e2)
    else:
        raise ValueError("loss must be 'squared' or 'absolute'")
    L = max(h - 1, bartlett_lag(T)) if lags is None else lags
    var = newey_west_var_of_mean(d, L)
    if var <= 0:
        return {"stat": float("nan"), "p": float("nan"), "meanDiff": float(d.mean()), "lags": L, "T": T}
    dm = d.mean() / math.sqrt(var)
    hln = math.sqrt((T + 1 - 2 * h + h * (h - 1) / T) / T)
    stat = dm * hln
    p = 2 * stats.t.sf(abs(stat), df=T - 1)
    return {"stat": float(stat), "p": float(p), "meanDiff": float(d.mean()), "lags": L, "T": T}


def wilson_interval(k: int, n: int, conf: float = 0.95) -> tuple[float, float]:
    """Wilson score interval for k successes out of n."""
    if n <= 0 or not 0 <= k <= n:
        raise ValueError("need 0 <= k <= n and n > 0")
    z = stats.norm.ppf(0.5 + conf / 2)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return float(centre - half), float(centre + half)


def clopper_pearson(k: int, n: int, conf: float = 0.95) -> tuple[float, float]:
    """Exact binomial interval."""
    if n <= 0 or not 0 <= k <= n:
        raise ValueError("need 0 <= k <= n and n > 0")
    a = 1 - conf
    lo = 0.0 if k == 0 else float(stats.beta.ppf(a / 2, k, n - k + 1))
    hi = 1.0 if k == n else float(stats.beta.ppf(1 - a / 2, k + 1, n - k))
    return lo, hi


def directional_accuracy(actual, forecast) -> dict:
    """Share of months where sign(forecast) == sign(actual); a zero forecast counts as 'up'."""
    a, f = _arr(actual), _arr(forecast)
    hits = int(np.sum((a > 0) == (f >= 0)))
    n = len(a)
    lo, hi = wilson_interval(hits, n)
    return {"hits": hits, "n": n, "accuracy": hits / n, "wilson95": [lo, hi]}


def qlike(realized_var, forecast_var) -> float:
    """Mean QLIKE loss (0 at a perfect forecast). Both inputs must be strictly positive."""
    rv, f = _arr(realized_var), _arr(forecast_var)
    if np.any(rv <= 0) or np.any(f <= 0):
        raise ValueError("variances must be positive")
    r = rv / f
    return float(np.mean(r - np.log(r) - 1))


def pinball(actual, q_forecast, tau: float) -> float:
    """Mean pinball loss of a tau-quantile forecast."""
    if not 0 < tau < 1:
        raise ValueError("tau must be in (0, 1)")
    a, q = _arr(actual), _arr(q_forecast)
    u = a - q
    return float(np.mean(np.maximum(tau * u, (tau - 1) * u)))


def band_coverage(actual, lo, hi, conf: float = 0.95) -> dict:
    """Share of outcomes inside [lo, hi], with a Clopper-Pearson interval."""
    a, l, u = _arr(actual), _arr(lo), _arr(hi)
    if np.any(l > u):
        raise ValueError("lower band above upper band")
    k = int(np.sum((a >= l) & (a <= u)))
    n = len(a)
    return {"inside": k, "n": n, "coverage": k / n, "exact95": list(clopper_pearson(k, n, conf))}
