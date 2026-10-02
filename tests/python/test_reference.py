"""pytest for the independent Python reference (tests/python/reference.py).

Pins the same published worked examples as tests/js/published.test.mjs (sources: research/parameters.md) and
cross-checks the OLS + Newey-West HAC implementation against statsmodels.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from scipy import stats

import reference as R

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

# ---------- Deflated Sharpe: Bailey & Lopez de Prado (2014) numerical example ----------
SR_DAILY = 2.5 / math.sqrt(250)
V_DAILY = 0.5 / 250


def test_dsr_main_example():
    sr0 = R.expected_max_sr(V_DAILY, 100)
    assert sr0 == pytest.approx(0.1132, abs=5e-5)
    assert R.psr(SR_DAILY, sr0, 1250, -3, 10) == pytest.approx(0.9004, abs=5e-5)


@pytest.mark.parametrize("N,skew,kurt,dsr", [(46, -3, 10, 0.9505), (88, 0, 3, 0.9505)])
def test_dsr_variants(N, skew, kurt, dsr):
    assert R.psr(SR_DAILY, R.expected_max_sr(V_DAILY, N), 1250, skew, kurt) == pytest.approx(dsr, abs=5e-5)


def test_dsr_pins_raw_kurtosis_convention():
    wrong = R.psr(SR_DAILY, R.expected_max_sr(V_DAILY, 100), 1250, -3, 7)  # excess kurtosis
    assert wrong == pytest.approx(0.9018, abs=5e-5)


def test_deflated_sharpe_uses_sample_variance_of_trials_and_needs_two():
    trials = [0.05, 0.12, -0.03, 0.2]
    out = R.deflated_sharpe(trials, 0.2, 240, 0, 3)
    assert out["V"] == pytest.approx(np.var(trials, ddof=1), rel=1e-15)
    assert R.deflated_sharpe([0.1], 0.1, 240, 0, 3) is None


# ---------- Minimum track record length: Bailey & Lopez de Prado (2012) Eq. 13 ----------
def min_trl_years(m, skew, kurt):
    return R.min_trl(2 / math.sqrt(m), 1 / math.sqrt(m), skew, kurt, 0.95) / m


@pytest.mark.parametrize("m,skew,kurt,years", [(252, 0, 3, 2.73), (52, 0, 3, 2.83), (12, 0, 3, 3.24),
                                               (12, -0.72, 5.78, 4.99)])
def test_min_trl(m, skew, kurt, years):
    assert round(min_trl_years(m, skew, kurt), 2) == years


# ---------- Lo (2002) eta(q) ----------
def test_lo_eta_iid():
    assert R.lo_eta([0.0] * 11, 12) == pytest.approx(math.sqrt(12), rel=1e-15)


def test_lo_eta_hand_example():
    assert R.lo_eta([0.4] + [0.0] * 10, 12) == pytest.approx(12 / math.sqrt(12 + 2 * 11 * 0.4), rel=1e-15)


def test_autocorr_matches_statsmodels_acf():
    from statsmodels.tsa.stattools import acf
    x = np.random.default_rng(1).standard_normal(200).cumsum() * 0.01
    ref = acf(x, nlags=11, adjusted=False, fft=False)
    for k in range(1, 12):
        assert R.autocorr(x, k) == pytest.approx(ref[k], rel=1e-12)


# ---------- Hand examples ----------
def test_drawdown_and_cagr_by_hand():
    net = np.array([0.10, -0.20, 0.05, 0.10, -0.10])
    mdd, lu = R.max_drawdown(net)
    assert mdd == pytest.approx(-0.2, rel=1e-14)
    assert lu == 4
    assert R.max_drawdown(np.array([-0.1, 0.05]))[0] == pytest.approx(-0.1)  # peak initialised at 1


# ---------- OLS + Newey-West HAC vs statsmodels ----------
def test_ols_hac_matches_statsmodels():
    """statsmodels' HAC equals the spec (Bartlett weights 1 - l/(L+1), no small-sample correction) with
    cov_kwds={'maxlags': L, 'use_correction': False}. In statsmodels 0.15 that is also the default for HAC;
    use_correction=True multiplies every SE by sqrt(T/(T-k)) instead (1.0088 for T = 289, k = 5)."""
    sm = pytest.importorskip("statsmodels.api")
    ds = json.loads((FIXTURES / "crosscheck-dataset.json").read_text())
    res = R.compare(ds, [(s, {}) for s in R.STRATEGY_IDS], R.COST_PRESETS["realistic"])
    w = res["window"]
    for run in res["runs"]:
        a = run["attribution"]
        X = np.column_stack([np.ones(len(run["excessNet"]))]
                            + [ds["factors"][k][w["firstEval"]: w["endIdx"] + 1] for k in R.FACTOR_ORDER])
        fit = sm.OLS(run["excessNet"], X).fit(cov_type="HAC",
                                               cov_kwds={"maxlags": a["lags"], "use_correction": False})
        np.testing.assert_allclose(a["beta"], fit.params, rtol=1e-10, atol=1e-14)
        np.testing.assert_allclose(a["se"], fit.bse, rtol=1e-10, atol=1e-14)
        assert a["r2"] == pytest.approx(fit.rsquared, rel=1e-10, abs=1e-14)
        corrected = sm.OLS(run["excessNet"], X).fit(cov_type="HAC",
                                                     cov_kwds={"maxlags": a["lags"], "use_correction": True})
        T, k = X.shape
        np.testing.assert_allclose(corrected.bse / a["se"], math.sqrt(T / (T - k)), rtol=1e-10)


def test_nw_lag_rule():
    assert [R.nw_lags(T) for T in (100, 240, 289, 1000)] == [4, 4, 5, 6]


# ---------- Sharpe-difference test ----------
def test_sharpe_diff_matches_direct_delta_method():
    """Recompute the delta-method SE with an independent loop-based Bartlett sum."""
    rng = np.random.default_rng(3)
    a = 0.01 + 0.05 * rng.standard_normal(40)
    b = 0.005 + 0.03 * rng.standard_normal(40)
    T = 40
    L = R.nw_lags(T)
    # Direct delta-method variance with a hand-rolled Bartlett sum, via numpy only.
    Y = np.column_stack([a - a.mean(), b - b.mean(), a * a - np.mean(a * a), b * b - np.mean(b * b)])
    psi = np.cov(Y, rowvar=False, bias=True)
    for l in range(1, L + 1):
        G = sum(np.outer(Y[t], Y[t - l]) for t in range(l, T)) / T
        psi = psi + (1 - l / (L + 1)) * (G + G.T)
    sa, sb = np.var(a), np.var(b)
    grad = np.array([np.mean(a * a) / sa ** 1.5, -np.mean(b * b) / sb ** 1.5,
                     -a.mean() / (2 * sa ** 1.5), b.mean() / (2 * sb ** 1.5)])
    out = R.sharpe_diff_test(a, b)
    assert out["diff"] == pytest.approx(a.mean() / a.std() - b.mean() / b.std(), rel=1e-12)
    assert out["se"] == pytest.approx(math.sqrt(grad @ psi @ grad / T), rel=1e-12)


def test_sharpe_diff_size_under_null():
    rng = np.random.default_rng(20260930)
    T, reps, rej = 240, 500, 0
    for _ in range(reps):
        a = 0.005 + 0.04 * rng.standard_normal(T)
        b = 0.01 + 0.08 * rng.standard_normal(T)
        rej += R.sharpe_diff_test(a, b)["p"] < 0.05
    assert 0.02 <= rej / reps <= 0.09


# ---------- Validation, fingerprint, strategies ----------
def test_validation_rejects_bad_data():
    ds = json.loads((FIXTURES / "crosscheck-dataset.json").read_text())
    R.validate_dataset(ds)
    for mutate in (lambda d: d["dates"].__setitem__(5, d["dates"][4]),
                   lambda d: d["dates"].__setitem__(5, "1990-13"),
                   lambda d: d["rf"].pop(),
                   lambda d: d["market"].__setitem__(3, -1.0),
                   lambda d: d["market"].__setitem__(3, 10.5),
                   lambda d: d["factors"]["SMB"].__setitem__(3, float("inf"))):
        bad = json.loads(json.dumps(ds))
        mutate(bad)
        with pytest.raises(ValueError):
            R.validate_dataset(bad)


def test_canonical_json_number_format_matches_javascript():
    for x, js in [(0.1, "0.1"), (1.0, "1"), (-0.95, "-0.95"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
                  (0.000001, "0.000001"), (123456789012345680000.0, "123456789012345680000"), (1e21, "1e+21"),
                  (-0.0012345, "-0.0012345"), (0.0, "0")]:
        assert R._js_number(x) == js


def test_rank_long_short_ties_lower_index_first():
    w = R.rank_long_short(np.array([0.1, 0.1, 0.0, 0.0]), 1)
    assert w.tolist() == [1.0, 0.0, 0.0, -1.0]
    # 2n > N: the middle asset gets both legs
    assert R.rank_long_short(np.array([3.0, 2.0, 1.0]), 2).tolist() == [0.5, 0.0, -0.5]


def test_faber_signal_by_hand():
    # market returns over the last L = 3 months: +10%, -5%, +1% -> P = 1.1, 1.045, 1.05545; mean 1.06682 > P_t
    Rm = np.array([[0.10, 0, 0], [-0.05, 0, 0], [0.01, 0, 0]])
    assert R.w_faber_sma(Rm, np.zeros(3), {"L": 3})[0] == 0.0
    Rm[2, 0] = 0.05
    assert R.w_faber_sma(Rm, np.zeros(3), {"L": 3})[0] == 1.0


def test_cscv_hand_example():
    """Spec §8 on the hand-worked case in tests/js/overfit.test.mjs: S = 2, two trials, PBO = 0, λ = ln 2."""
    M = np.array([[1, 0], [3, 4], [0, 2], [2, 2]], dtype=float)
    out = R.cscv(M, 2)
    assert out["combinations"] == 2 and out["pbo"] == 0.0
    assert np.allclose(out["lambdas"], [math.log(2)] * 2)


def test_cscv_null_calibration():
    rng = np.random.default_rng(1)
    pbos = [R.cscv(rng.standard_normal((480, 20)) * 0.01, 8)["pbo"] for _ in range(30)]
    assert 0.38 < float(np.mean(pbos)) < 0.62


def test_pairs_warmup_and_universe():
    assert R.warmup("ggr-pairs", R.DEFAULT_PARAMS["ggr-pairs"]) == 17
    Rm = np.zeros((20, 4)); Rm[:, 1:] = 0.01
    w = R.w_ggr_pairs(Rm, np.zeros(20), R.DEFAULT_PARAMS["ggr-pairs"])
    assert w[0] == 0.0  # never trades the Market column


def test_cscv_flat_column_scores_zero():
    rng = np.random.default_rng(21)
    M = np.column_stack([rng.standard_normal((160, 5)) * 0.01, np.full(160, 0.001)])
    out = R.cscv(M, 16)
    assert out["combinations"] == 12870
    with pytest.raises(ValueError):
        R.cscv(M, 22)
