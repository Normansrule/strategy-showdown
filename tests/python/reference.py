"""Independent Python reference implementation of docs/ENGINE_SPEC.md.

Written from the specification alone (not from the JavaScript engine) so that the
cross-language tests in tests/js/crosscheck.test.mjs compare two independent
implementations. One function per spec item; section numbers refer to ENGINE_SPEC.md.

Conventions shared with the spec:
  * monthly data, q = 12 periods per year
  * universe U = [Market, asset_1, ..., asset_N] (asset order = order in the dataset JSON)
  * a decision at the end of row t uses rows 0..t only and earns row t+1
"""
from __future__ import annotations

import hashlib
import json
import itertools
import math
import re
from dataclasses import dataclass, field

import numpy as np
from scipy import stats

Q = 12  # periods per year (spec §5)
EULER_GAMMA = 0.5772156649015329

# Cost presets (spec §4) -- assumptions, adjustable.
COST_PRESETS = {
    "naive": {"tradeCostBps": 0.0, "borrowBpsPerYear": 0.0},
    "realistic": {"tradeCostBps": 10.0, "borrowBpsPerYear": 50.0},
}

# Default parameters (spec §6).
DEFAULT_PARAMS = {
    "buy-hold-market": {},
    "equal-weight": {},
    "faber-sma": {"L": 10},
    "tsmom": {"k": 12, "target": 0.40, "com": 3},
    "xs-momentum": {"J": 6, "K": 6, "skip": 0, "n": 3},
    "st-reversal": {"n": 3},
    "mean-variance": {"M": 120},
    "ggr-pairs": {"F": 12, "Tr": 6, "n": 5, "k": 2.0},
}
STRATEGY_IDS = list(DEFAULT_PARAMS)


# ---------------------------------------------------------------------------
# §1 Data: validation and fingerprint
# ---------------------------------------------------------------------------
_DATE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def validate_dataset(ds: dict) -> None:
    """Raise ValueError if the dataset violates §1."""
    dates = ds["dates"]
    for d in dates:
        if not isinstance(d, str) or not _DATE_RE.match(d):
            raise ValueError(f"malformed date {d!r}")
    for a, b in zip(dates, dates[1:]):
        if not a < b:  # YYYY-MM strings sort lexicographically
            raise ValueError(f"dates not strictly increasing at {b}")
    T = len(dates)
    series = {"rf": ds["rf"], "market": ds["market"]}
    for k, v in ds["assets"].items():
        series[f"assets.{k}"] = v
    for k, v in (ds.get("factors") or {}).items():
        series[f"factors.{k}"] = v
    for name, v in series.items():
        if len(v) != T:
            raise ValueError(f"{name} has length {len(v)}, expected {T}")
        for i, x in enumerate(v):
            if x is None or not math.isfinite(x) or not (-1 < x <= 10):
                raise ValueError(f"{name}[{i}] = {x!r} not finite in (-1, 10]")


def _js_number(x: float) -> str:
    """Format a float exactly like JavaScript's Number.prototype.toString / JSON.stringify.

    Both Python repr and JS use the shortest round-trip digit string; they differ only
    in when exponent notation is used and how it is written.
    """
    if x == 0:
        return "0"
    if x != x or x in (math.inf, -math.inf):
        return "null"
    s = repr(float(x))
    sign = "-" if s.startswith("-") else ""
    s = s.lstrip("-")
    # decompose into digits and decimal exponent n such that value = 0.d1d2... * 10^n
    if "e" in s:
        mant, exp = s.split("e")
        exp = int(exp)
    else:
        mant, exp = s, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = (ip + fp).lstrip("0")
    lead_zeros = len(ip + fp) - len((ip + fp).lstrip("0"))
    n = len(ip) + exp - lead_zeros  # position of decimal point relative to digits
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = f"e{'+' if e >= 0 else '-'}{abs(e)}"
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + es
    return sign + out


def canonical_json(obj) -> str:
    """Canonical JSON: sorted keys, no whitespace, JS number formatting."""
    if isinstance(obj, dict):
        items = sorted(obj.items())
        return "{" + ",".join(json.dumps(k) + ":" + canonical_json(v) for k, v in items) + "}"
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in obj) + "]"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if obj is None:
        return "null"
    if isinstance(obj, (int, float)):
        return _js_number(float(obj))
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=False)
    raise TypeError(type(obj))


def dataset_fingerprint(ds: dict) -> str:
    sub = {k: ds.get(k) for k in ("dates", "rf", "market", "assets", "factors")}
    if sub["factors"] is None:
        sub["factors"] = {}
    return hashlib.sha256(canonical_json(sub).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# §2 Universe
# ---------------------------------------------------------------------------
def universe_matrix(ds: dict) -> tuple[list[str], np.ndarray, np.ndarray]:
    """Return (names, R, rf) with R[t, j] the total return of U_j at row t."""
    names = ["Market"] + list(ds["assets"])
    cols = [ds["market"]] + [ds["assets"][k] for k in ds["assets"]]
    R = np.column_stack([np.asarray(c, dtype=float) for c in cols])
    return names, R, np.asarray(ds["rf"], dtype=float)


# ---------------------------------------------------------------------------
# §6 Strategies: warmup and weights at decision t (R, rf truncated at row t)
# ---------------------------------------------------------------------------
def warmup(sid: str, p: dict) -> int:
    if sid in ("buy-hold-market", "equal-weight", "st-reversal"):
        return 1
    if sid == "faber-sma":
        return p["L"]
    if sid == "tsmom":
        return max(p["k"], 24)
    if sid == "xs-momentum":
        return p["J"] + p["skip"] + p["K"] - 1
    if sid == "mean-variance":
        return p["M"]
    if sid == "ggr-pairs":
        return p["F"] + p["Tr"] - 1
    raise KeyError(sid)


def cumret(r: np.ndarray, a: int, b: int) -> float:
    """c(r, a, b) = prod_{i=a..b}(1 + r_i) - 1 (inclusive)."""
    return float(np.prod(1.0 + r[a : b + 1]) - 1.0)


def w_buy_hold_market(R, rf, p):
    w = np.zeros(R.shape[1]); w[0] = 1.0
    return w


def w_equal_weight(R, rf, p):
    N = R.shape[1] - 1
    w = np.zeros(N + 1); w[1:] = 1.0 / N
    return w


def w_faber_sma(R, rf, p):
    L = p["L"]; t = R.shape[0] - 1
    m = R[t - L + 1 : t + 1, 0]
    P = np.cumprod(1.0 + m)  # P_i for i = t-L+1..t
    w = np.zeros(R.shape[1])
    w[0] = 1.0 if P[-1] > P.mean() else 0.0
    return w


def w_tsmom(R, rf, p):
    k, target, com = p["k"], p["target"], p["com"]
    t = R.shape[0] - 1
    N = R.shape[1] - 1
    delta = com / (1.0 + com)
    max_lag = min(t, math.ceil(math.log(1e-12) / math.log(delta)))
    lags = np.arange(0, max_lag + 1)
    omega = (1 - delta) * delta ** lags
    w = np.zeros(N + 1)
    for j in range(1, N + 1):
        x = R[:, j] - rf
        signal = np.sign(np.prod(1.0 + x[t - k + 1 : t + 1]) - 1.0)
        xl = x[t - lags]
        xbar = np.sum(omega * xl) / np.sum(omega)
        sigma = math.sqrt(12.0 * np.sum(omega * (xl - xbar) ** 2) / np.sum(omega))
        w[j] = 0.0 if sigma == 0 else signal * target / sigma / N
    return w


def rank_long_short(scores: np.ndarray, n: int) -> np.ndarray:
    """+1/n on the top n, -1/n on the bottom n; sort desc, ties -> lower index first."""
    N = len(scores)
    order = sorted(range(N), key=lambda j: (-scores[j], j))
    w = np.zeros(N)
    for j in order[:n]:
        w[j] += 1.0 / n
    for j in order[N - n :]:
        w[j] -= 1.0 / n
    return w


def _xs_weights(R, J, K, skip, n, direction):
    t = R.shape[0] - 1
    N = R.shape[1] - 1
    acc = np.zeros(N)
    for c in range(K):
        a, b = t - c - skip - J + 1, t - c - skip
        scores = np.array([cumret(R[:, j + 1], a, b) for j in range(N)])
        acc += rank_long_short(scores, n) / K
    w = np.zeros(N + 1)
    w[1:] = direction * acc
    return w


def w_xs_momentum(R, rf, p):
    return _xs_weights(R, p["J"], p["K"], p["skip"], p["n"], +1.0)


def w_st_reversal(R, rf, p):
    return _xs_weights(R, 1, 1, 0, p["n"], -1.0)


def w_mean_variance(R, rf, p):
    M = p["M"]; t = R.shape[0] - 1
    N = R.shape[1] - 1
    X = R[t - M + 1 : t + 1, 1:] - rf[t - M + 1 : t + 1, None]
    mu = X.mean(axis=0)
    S = np.cov(X, rowvar=False, ddof=1)
    w = np.zeros(N + 1)
    # "Singular" is judged numerically: the spec gives no threshold, and np.linalg.solve only raises on an
    # exactly-zero pivot (a duplicated asset gives cond ~1e33 and garbage weights instead). Numerical rank via
    # SVD (NumPy's default tolerance S.max * max(M, N) * eps) is the standard test.
    if np.linalg.matrix_rank(S) < N:
        w[1:] = 1.0 / N
        return w
    raw = np.linalg.solve(S, mu)
    s = raw.sum()
    if abs(s) < 1e-12:
        return w
    w[1:] = raw / s
    return w


def _pairs_cohort(A: np.ndarray, e: int, t: int, F: int, n: int, k: float) -> np.ndarray:
    """Spec §6.1, one cohort with formation end e; A[row, j] = asset returns (no Market column)."""
    N = A.shape[1]
    w = np.zeros(N)
    if e - F + 1 < 0:
        return w
    P = np.vstack([np.ones(N), np.cumprod(1.0 + A[e - F + 1 : e + 1, :], axis=0)])  # rows m = 0..F
    D2 = ((P[1:, :, None] - P[1:, None, :]) ** 2).sum(axis=0)  # SSD(i, j)
    pairs = {}
    for i in range(N):
        cand = [(D2[i, j], j) for j in range(N) if j != i]
        d, j = min(cand, key=lambda x: (x[0], x[1]))
        a, b = min(i, j), max(i, j)
        pairs.setdefault((a, b), d)
    chosen = sorted(pairs.items(), key=lambda kv: (kv[1], kv[0][0], kv[0][1]))[:n]
    for (a, b), _ in chosen:
        sigma = float(np.std(P[1:, a] - P[1:, b], ddof=1))
        if not sigma > 0:
            continue
        qa = qb = 1.0
        is_open, g, qa0, qb0 = False, 0.0, 1.0, 1.0
        for s_ in range(e, t + 1):
            if s_ > e:
                qa *= 1.0 + A[s_, a]
                qb *= 1.0 + A[s_, b]
            d = qa - qb
            if is_open and (d == 0 or np.sign(d) != g):
                is_open = False
            if not is_open and abs(d) > k * sigma:
                is_open, g, qa0, qb0 = True, float(np.sign(d)), qa, qb
        if is_open:
            if g > 0:
                w[a] -= (qa / qa0) / n; w[b] += (qb / qb0) / n
            else:
                w[b] -= (qb / qb0) / n; w[a] += (qa / qa0) / n
    return w


def w_ggr_pairs(R, rf, p):
    F, Tr, n, k = p["F"], p["Tr"], p["n"], p["k"]
    t = R.shape[0] - 1
    A = R[:, 1:]
    acc = np.zeros(A.shape[1])
    for c in range(Tr):
        acc += _pairs_cohort(A, t - c, t, F, n, k) / Tr
    w = np.zeros(R.shape[1])
    w[1:] = acc
    return w


STRATEGY_FUNCS = {
    "buy-hold-market": w_buy_hold_market,
    "equal-weight": w_equal_weight,
    "faber-sma": w_faber_sma,
    "tsmom": w_tsmom,
    "xs-momentum": w_xs_momentum,
    "st-reversal": w_st_reversal,
    "mean-variance": w_mean_variance,
    "ggr-pairs": w_ggr_pairs,
}


# ---------------------------------------------------------------------------
# §3 Common evaluation window
# ---------------------------------------------------------------------------
def common_window(ds: dict, specs: list[tuple[str, dict]], start: str | None = None,
                  end: str | None = None) -> dict:
    dates = ds["dates"]
    warms = [warmup(sid, p) for sid, p in specs]
    max_warm = max(warms)
    binding = specs[warms.index(max_warm)][0]
    start_idx = 0 if start is None else next(i for i, d in enumerate(dates) if d >= start)
    end_idx = len(dates) - 1 if end is None else max(i for i, d in enumerate(dates) if d <= end)
    first_eval = max(start_idx, max_warm)
    if end_idx - first_eval < 11:
        raise ValueError("fewer than 12 evaluated months")
    return {"maxWarm": max_warm, "binding": binding, "startIdx": start_idx,
            "firstEval": first_eval, "endIdx": end_idx,
            "evalStart": dates[first_eval], "evalEnd": dates[end_idx]}


# ---------------------------------------------------------------------------
# §4 Accounting
# ---------------------------------------------------------------------------
def run_strategy(ds: dict, sid: str, params: dict, window: dict, costs: dict) -> dict:
    names, R, rf = universe_matrix(ds)
    f, e = window["firstEval"], window["endIdx"]
    cost_rate = costs["tradeCostBps"] / 1e4
    borrow_rate = costs["borrowBpsPerYear"] / 1e4 / 12
    nU = R.shape[1]
    drifted = np.zeros(nU)
    out = {k: [] for k in ("net", "excessNet", "grossExcess", "turnover", "tradeCost",
                           "borrow", "grossExposure", "netExposure")}
    weights = []
    ruined_at = None
    for t in range(f - 1, e):
        r1, rf1 = R[t + 1], rf[t + 1]
        if ruined_at is not None:
            for k, v in (("net", 0.0), ("excessNet", -rf1), ("grossExcess", -rf1),
                         ("turnover", 0.0), ("tradeCost", 0.0), ("borrow", 0.0),
                         ("grossExposure", 0.0), ("netExposure", 0.0)):
                out[k].append(v)
            weights.append(np.zeros(nU))
            continue
        w = STRATEGY_FUNCS[sid](R[: t + 1], rf[: t + 1], params)
        weights.append(w)
        turnover = float(np.sum(np.abs(w - drifted)))
        trade_cost = turnover * cost_rate
        borrow = float(np.sum(np.maximum(-w, 0.0))) * borrow_rate
        excess = float(np.sum(w * (r1 - rf1)))
        net = rf1 + excess - borrow - trade_cost
        gross_excess = excess - borrow
        V = 1.0 + rf1 + excess - borrow
        if net <= -1:
            net = -1.0
            ruined_at = ds["dates"][t + 1]
        else:
            drifted = w * (1.0 + r1) / V
        out["net"].append(net)
        out["excessNet"].append(net - rf1)
        out["grossExcess"].append(gross_excess)
        out["turnover"].append(turnover)
        out["tradeCost"].append(trade_cost)
        out["borrow"].append(borrow)
        out["grossExposure"].append(float(np.sum(np.abs(w))))
        out["netExposure"].append(float(np.sum(w)))
    res = {k: np.asarray(v) for k, v in out.items()}
    res["dates"] = ds["dates"][f : e + 1]
    res["weights"] = np.asarray(weights)
    res["ruinedAt"] = ruined_at
    res["universe"] = names
    return res


# ---------------------------------------------------------------------------
# §5 Metrics
# ---------------------------------------------------------------------------
def skewness(x) -> float:
    return float(stats.skew(np.asarray(x), bias=True))


def kurtosis_raw(x) -> float:
    return float(stats.kurtosis(np.asarray(x), fisher=False, bias=True))


def autocorr(x, k: int) -> float:
    """Sample autocorrelation at lag k; autocovariance and variance both divided by T."""
    x = np.asarray(x, dtype=float); d = x - x.mean(); T = len(x)
    return float(np.sum(d[k:] * d[: T - k]) / T / (np.sum(d * d) / T))


def lo_eta(rhos: list[float], q: int) -> float:
    """Lo (2002) Eq. 20: eta(q) = q / sqrt(q + 2 sum_{k=1}^{q-1} (q-k) rho_k); rhos[k-1] = rho_k."""
    s = sum((q - k) * rhos[k - 1] for k in range(1, q))
    return q / math.sqrt(q + 2 * s)


def psr(sr: float, sr_star: float, T: int, skew: float, kurt_raw: float) -> float:
    """Bailey & Lopez de Prado (2012) Eq. 11, sqrt(T-1), raw kurtosis."""
    den = math.sqrt(1 - skew * sr + (kurt_raw - 1) / 4 * sr * sr)
    return float(stats.norm.cdf((sr - sr_star) * math.sqrt(T - 1) / den))


def min_trl(sr: float, sr_star: float, skew: float, kurt_raw: float, prob: float = 0.95) -> float:
    """Bailey & Lopez de Prado (2012) Eq. 13, in observations."""
    z = stats.norm.ppf(prob)
    return 1 + (1 - skew * sr + (kurt_raw - 1) / 4 * sr * sr) * (z / (sr - sr_star)) ** 2


def max_drawdown(net) -> tuple[float, int]:
    W = np.cumprod(1.0 + np.asarray(net))
    peak = np.maximum.accumulate(np.concatenate([[1.0], W]))[1:]
    dd = W / peak - 1
    longest = run = 0
    for v in dd:
        run = run + 1 if v < 0 else 0
        longest = max(longest, run)
    return float(dd.min()), longest


def metrics(run: dict) -> dict:
    net = run["net"]; ex = run["excessNet"]; T = len(ex)
    mu = ex.mean(); sd = ex.std(ddof=1)
    growth = float(np.prod(1.0 + net))
    sr = mu / sd
    se = math.sqrt((1 + sr * sr / 2) / T)
    z = stats.norm.ppf(0.975)
    rhos = [autocorr(ex, k) for k in range(1, Q)]
    dd_down = math.sqrt(np.sum(np.minimum(ex, 0.0) ** 2) / T)
    mdd, lu = max_drawdown(net)
    sk, ku = skewness(ex), kurtosis_raw(ex)
    mt = run["turnover"].mean()
    return {
        "T": T,
        "totalReturn": growth - 1,
        "cagr": growth ** (Q / T) - 1,
        "annMeanExcess": mu * Q,
        "annVol": sd * math.sqrt(Q),
        "sharpePerPeriod": sr,
        "sharpe": sr * math.sqrt(Q),
        "sharpeCI": [(sr - z * se) * math.sqrt(Q), (sr + z * se) * math.sqrt(Q)],
        "sharpeLoAdjusted": sr * lo_eta(rhos, Q),
        "sortino": mu / dd_down * math.sqrt(Q) if dd_down > 0 else math.nan,
        "maxDrawdown": mdd,
        "longestUnderwater": lu,
        "hitRate": float(np.mean(ex > 0)),
        "skew": sk,
        "kurtosis": ku,
        "psrVsZero": psr(sr, 0.0, T, sk, ku),
        "ceq": (mu - 0.5 * ex.var(ddof=1)) * Q,
        "annTurnover": mt * Q,
        "avgGrossExposure": float(run["grossExposure"].mean()),
        "avgNetExposure": float(run["netExposure"].mean()),
        "breakEvenCostBps": (run["grossExcess"].mean() / mt * 1e4) if mt != 0 else math.inf,
    }


def expected_max_sr(V: float, N: int) -> float:
    """SR0 of §5 (Bailey & Lopez de Prado 2014 Eq. 1 with mu = 0)."""
    zi = stats.norm.ppf
    return math.sqrt(V) * ((1 - EULER_GAMMA) * zi(1 - 1 / N) + EULER_GAMMA * zi(1 - 1 / (N * math.e)))


def deflated_sharpe(trials: list[float], sr: float, T: int, skew: float, kurt_raw: float):
    """DSR = PSR(SR0); None when fewer than 2 trials."""
    N = len(trials)
    if N < 2:
        return None
    V = float(np.var(trials, ddof=1))
    sr0 = expected_max_sr(V, N)
    return {"sr0": sr0, "dsr": psr(sr, sr0, T, skew, kurt_raw), "N": N, "V": V}


def nw_lags(T: int) -> int:
    return int(math.floor(4 * (T / 100) ** (2 / 9)))


def bartlett(l: int, L: int) -> float:
    return 1 - l / (L + 1)


def sharpe_diff_test(a, b) -> dict:
    """Delta-method HAC test of SR_a - SR_b = 0 (§5)."""
    a = np.asarray(a, float); b = np.asarray(b, float); T = len(a)
    mua, mub = a.mean(), b.mean()
    ea2, eb2 = np.mean(a * a), np.mean(b * b)
    sa, sb = ea2 - mua ** 2, eb2 - mub ** 2
    delta = mua / math.sqrt(sa) - mub / math.sqrt(sb)
    grad = np.array([ea2 / sa ** 1.5, -eb2 / sb ** 1.5, -mua / (2 * sa ** 1.5), mub / (2 * sb ** 1.5)])
    Y = np.column_stack([a - mua, b - mub, a * a - ea2, b * b - eb2])
    L = nw_lags(T)
    psi = Y.T @ Y / T
    for l in range(1, L + 1):
        G = Y[l:].T @ Y[:-l] / T
        psi += bartlett(l, L) * (G + G.T)
    se = math.sqrt(grad @ psi @ grad / T)
    zstat = delta / se
    return {"diff": delta, "se": se, "z": zstat, "p": float(2 * stats.norm.sf(abs(zstat))), "lags": L}


def ols_hac(y, X) -> dict:
    """OLS with Newey-West Bartlett HAC covariance, L = floor(4(T/100)^(2/9)), no small-sample correction."""
    y = np.asarray(y, float); X = np.asarray(X, float); T = len(y)
    XtX_inv = np.linalg.inv(X.T @ X)
    beta = XtX_inv @ X.T @ y
    u = y - X @ beta
    L = nw_lags(T)
    Xu = X * u[:, None]
    S = Xu.T @ Xu
    for l in range(1, L + 1):
        G = Xu[l:].T @ Xu[:-l]  # sum_t u_t u_{t-l} x_t x_{t-l}^T
        S += bartlett(l, L) * (G + G.T)
    cov = XtX_inv @ S @ XtX_inv
    se = np.sqrt(np.diag(cov))
    ssr = float(u @ u); sst = float(np.sum((y - y.mean()) ** 2))
    return {"beta": beta, "se": se, "t": beta / se, "r2": 1 - ssr / sst, "lags": L, "cov": cov}


FACTOR_ORDER = ["MktRF", "SMB", "HML", "Mom"]


def factor_attribution(ds: dict, window: dict, ex) -> dict | None:
    fac = ds.get("factors") or {}
    names = [k for k in FACTOR_ORDER if k in fac]
    if not names:
        return None
    f, e = window["firstEval"], window["endIdx"]
    X = np.column_stack([np.ones(e - f + 1)] + [np.asarray(fac[k][f : e + 1], float) for k in names])
    res = ols_hac(ex, X)
    res["names"] = ["alpha"] + names
    return res


def correlation_matrix(exs: list[np.ndarray]) -> np.ndarray:
    return np.corrcoef(np.vstack(exs))


# ---------------------------------------------------------------------------
# Full comparison
# ---------------------------------------------------------------------------
def compare(ds: dict, specs: list[tuple[str, dict]], costs: dict, start=None, end=None,
            benchmark_index: int = 0, trials: list[float] | None = None) -> dict:
    """Run every spec under identical conditions.

    `trials`: per-period Sharpe ratios of EVERY configuration tried (spec §5). When given (and at least as long
    as the number of runs shown) it is used as the complete list; otherwise the shown runs' Sharpe ratios are.
    """
    validate_dataset(ds)
    specs = [(sid, {**DEFAULT_PARAMS[sid], **(p or {})}) for sid, p in specs]
    win = common_window(ds, specs, start, end)
    runs = []
    for sid, p in specs:
        r = run_strategy(ds, sid, p, win, costs)
        r["id"] = sid; r["params"] = p
        r["metrics"] = metrics(r)
        runs.append(r)
    if not trials or len(trials) < len(runs):
        trials = [r["metrics"]["sharpePerPeriod"] for r in runs]
    for r in runs:
        m = r["metrics"]
        r["dsr"] = deflated_sharpe(trials, m["sharpePerPeriod"], m["T"], m["skew"], m["kurtosis"])
        r["attribution"] = factor_attribution(ds, win, r["excessNet"])
    bench = runs[benchmark_index]["excessNet"]
    for i, r in enumerate(runs):
        r["vsBenchmark"] = None if i == benchmark_index else sharpe_diff_test(r["excessNet"], bench)
    return {"window": win, "runs": runs, "fingerprint": dataset_fingerprint(ds),
            "correlation": correlation_matrix([r["excessNet"] for r in runs])}


# ---------------------------------------------------------------------------
# §8 Probability of backtest overfitting (CSCV)
# ---------------------------------------------------------------------------
def cscv(M: np.ndarray, S: int) -> dict:
    """M[t, n] = per-period excess return of trial n. Spec §8."""
    T, N = M.shape
    if S < 2 or S % 2 or S > 20:
        raise ValueError("S must be an even integer from 2 to 20")
    if N < 2:
        raise ValueError("need at least 2 trials")
    if not np.all(np.isfinite(M)):
        raise ValueError("non-finite return")
    L = T // S
    if L < 2:
        raise ValueError("too few rows for S blocks")
    X = M[T - L * S :, :]
    blocks = [X[s * L : (s + 1) * L, :] for s in range(S)]

    def sharpe(rows):
        sd = rows.std(axis=0, ddof=1)  # NumPy std is two-pass
        mu = rows.mean(axis=0)
        flat = sd <= 1e-12 * np.maximum(np.abs(mu), 1e-12)
        return np.where(flat, 0.0, mu / np.where(flat, 1.0, sd))

    lam, is_sr, oos_sr = [], [], []
    for J in itertools.combinations(range(S), S // 2):
        Jbar = [b for b in range(S) if b not in J]
        R_ = sharpe(np.vstack([blocks[b] for b in J]))
        Rb = sharpe(np.vstack([blocks[b] for b in Jbar]))
        tie = 1e-12  # spec §8: values within 1e-12 are equal
        star = 0
        for n_ in range(1, N):
            if R_[n_] > R_[star] + tie:
                star = n_
        others = np.delete(Rb, star)
        below = int(np.sum(others < Rb[star] - tie))
        ties = int(np.sum(np.abs(others - Rb[star]) <= tie))
        omega = (1 + below + 0.5 * ties) / (N + 1)
        lam.append(math.log(omega / (1 - omega)))
        is_sr.append(float(R_[star])); oos_sr.append(float(Rb[star]))
    lam = np.array(lam); x = np.array(is_sr); y = np.array(oos_sr)
    C = len(lam)
    xc, yc = x - x.mean(), y - y.mean()
    sxx, syy, sxy = float(xc @ xc), float(yc @ yc), float(xc @ yc)
    slope = sxy / sxx if sxx > 0 else 0.0
    return {"pbo": float(np.sum(lam <= 0) / C), "probLoss": float(np.sum(y < 0) / C), "combinations": C,
            "lambdas": lam.tolist(), "slope": slope, "intercept": float(y.mean() - slope * x.mean()),
            "r2": (sxy * sxy) / (sxx * syy) if sxx > 0 and syy > 0 else 0.0}
