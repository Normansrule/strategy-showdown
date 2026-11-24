"""G3: forecast metrics, walk-forward protocol and pass criteria (timesfm_eval/). Synthetic data only."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest
import statsmodels.api as sm
from statsmodels.stats.proportion import proportion_confint

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from timesfm_eval import metrics as M  # noqa: E402
from timesfm_eval import protocol as P  # noqa: E402
from timesfm_eval import synthetic as S  # noqa: E402
from timesfm_eval import model as TF  # noqa: E402


# ---------------------------------------------------------------- metrics against hand values and statsmodels
def test_mase_hand_example():
    insample = [1.0, 2.0, 4.0, 3.0]          # naive errors 1, 2, 1 -> scale 4/3
    assert M.mase([5.0, 5.0], [4.0, 7.0], insample) == pytest.approx((1 + 2) / 2 / (4 / 3))


def test_mase_rejects_constant_insample():
    with pytest.raises(ValueError):
        M.mase([1.0], [1.0], [2.0, 2.0, 2.0])


@pytest.mark.parametrize("k,n", [(7, 10), (0, 13), (13, 13), (61, 100), (5, 13)])
def test_wilson_and_clopper_pearson_match_statsmodels(k, n):
    assert M.wilson_interval(k, n) == pytest.approx(proportion_confint(k, n, alpha=0.05, method="wilson"), abs=1e-12)
    assert M.clopper_pearson(k, n) == pytest.approx(proportion_confint(k, n, alpha=0.05, method="beta"), abs=1e-12)


def test_wilson_published_value():
    # Newcombe (1998), Table I: 15/148 -> 0.0624 to 0.1605 (Wilson score)
    lo, hi = M.wilson_interval(15, 148)
    assert lo == pytest.approx(0.0624, abs=5e-5) and hi == pytest.approx(0.1605, abs=5e-5)


def test_newey_west_matches_statsmodels_hac():
    d = S.ar1(300, phi=0.4, seed=11)
    for lags in (0, 1, 5):
        res = sm.OLS(d, np.ones_like(d)).fit(cov_type="HAC", cov_kwds={"maxlags": lags, "use_correction": False})
        assert M.newey_west_var_of_mean(d, lags) == pytest.approx(res.bse[0] ** 2, rel=1e-10)


def test_bartlett_lag_matches_js_rule():
    assert [M.bartlett_lag(T) for T in (13, 100, 120, 816)] == [math.floor(4 * (T / 100) ** (2 / 9)) for T in (13, 100, 120, 816)]


def test_dm_sign_and_symmetry():
    rng = np.random.default_rng(5)
    good = rng.normal(0, 1, 400)
    bad = good + rng.normal(0, 1, 400)
    r = M.diebold_mariano(good, bad)
    assert r["stat"] < 0 and r["p"] < 1e-6
    r2 = M.diebold_mariano(bad, good)
    assert r2["stat"] == pytest.approx(-r["stat"]) and r2["p"] == pytest.approx(r["p"])
    same = M.diebold_mariano(good, good)
    assert math.isnan(same["stat"])  # identical errors: no variance, no test


def test_dm_size_under_the_null_is_close_to_5pct():
    rng = np.random.default_rng(9)
    rej = 0
    for _ in range(600):
        e1, e2 = rng.normal(0, 1, 120), rng.normal(0, 1, 120)
        rej += M.diebold_mariano(e1, e2)["p"] < 0.05
    assert 0.02 < rej / 600 < 0.09


def test_qlike_pinball_coverage():
    assert M.qlike([1.0, 2.0], [1.0, 2.0]) == 0.0
    assert M.qlike([2.0], [1.0]) == pytest.approx(2 - math.log(2) - 1)
    assert M.pinball([1.0, -1.0], [0.0, 0.0], 0.9) == pytest.approx((0.9 * 1 + 0.1 * 1) / 2)
    cov = M.band_coverage([0, 1, 2, 3, 10], [-1] * 5, [5] * 5)
    assert cov["inside"] == 4 and cov["coverage"] == 0.8
    with pytest.raises(ValueError):
        M.qlike([0.0], [1.0])


def test_directional_accuracy_counts_zero_forecast_as_up():
    da = M.directional_accuracy([0.1, -0.2, 0.3, -0.1], [0.0, -0.1, 0.2, 0.05])
    assert da["hits"] == 3 and da["n"] == 4


# ---------------------------------------------------------------- protocol
def test_walk_forward_never_sees_the_future():
    dates = S.months(1990, 200)
    x = S.iid(200, seed=4)
    seen = []

    def spy(context, history, horizon):
        seen.append((len(history), history[-1], len(context)))
        return {"mean": [history[-1]], "q10": [-1.0], "q30": [-0.5], "q50": [0.0], "q90": [1.0]}

    p = P.walk_forward(dates, x, spy, name="spy", context=64, burn_in=120)
    assert p.dates[0] == dates[120] and len(p.dates) == 80
    for i, (n_hist, last, n_ctx) in enumerate(seen):
        assert n_hist == 120 + i and last == x[119 + i] and n_ctx == min(64, n_hist)
    np.testing.assert_array_equal(p.forecast["mean"], x[119:-1])  # last value seen = the month before the target


def test_walk_forward_rejects_bad_forecasters():
    dates, x = S.months(1990, 130), S.iid(130)
    crossed = lambda c, h, k: {"mean": [0.0], "q10": [1.0], "q30": [0.5], "q50": [0.0], "q90": [-1.0]}  # noqa: E731
    with pytest.raises(ValueError, match="crossed"):
        P.walk_forward(dates, x, crossed, name="x")
    nan = lambda c, h, k: {"mean": [float("nan")], "q10": [0.0], "q30": [0.0], "q50": [0.0], "q90": [0.0]}  # noqa: E731
    with pytest.raises(ValueError, match="bad mean"):
        P.walk_forward(dates, x, nan, name="x")


def test_windows():
    dates = ["2023-11", "2023-12", "2025-09", "2025-10", "2026-10"]
    assert P.window_mask(dates, "A").tolist() == [False, False, False, True, True]
    assert P.window_mask(dates, "B").tolist() == [False, True, True, True, True]
    assert P.window_mask(dates, "C").all()


def _paths(series, model_fn, n=420):
    dates = S.months(1990, n)
    model = P.walk_forward(dates, series, model_fn, name="model")
    base = {k: P.walk_forward(dates, series, f, name=k) for k, f in P.BASELINES.items()}
    return model, base


def test_an_oracle_on_predictable_data_passes_returns_and_a_baseline_does_not():
    phi, mu = 0.6, 0.0
    x = S.ar1(420, phi=phi, mu=mu, sigma=0.02, seed=21)
    sd = 0.02

    def oracle(context, history, horizon):
        m = mu + phi * (history[-1] - mu)
        return {"mean": [m], "q10": [m - 1.2816 * sd], "q30": [m - 0.5244 * sd], "q50": [m], "q90": [m + 1.2816 * sd]}

    model, base = _paths(x, oracle)
    rB = P.evaluate(model, base, "B", break_even=0.55)
    assert rB["n"] == 13  # 2023-12 .. 2024-12
    rC = P.evaluate(model, base, "C", break_even=0.55)
    assert rC["mase"] < 1
    assert all(v["squared"]["stat"] < 0 for v in rC["dm"].values())
    assert rC["tests"]["returns"]["applies"] is False and rC["tests"]["returns"]["pass"] is False  # only Window B can pass
    assert rC["tests"]["calibration"]["pass"] is True
    # the historical mean scored as the "model" on i.i.d. data shows no skill
    y = S.iid(420, seed=22)
    m2, b2 = _paths(y, P.historical_mean)
    r = P.evaluate(m2, {"random walk": b2["random walk"]}, "C", break_even=0.6)
    assert r["tests"]["direction"]["pass"] is False


def test_direction_test_is_not_run_without_a_break_even():
    x = S.iid(420, seed=3)
    model, base = _paths(x, P.historical_mean)
    r = P.evaluate(model, base, "B", break_even=None)
    assert r["tests"]["direction"]["pass"] is None
    assert r["tests"]["volatility"]["pass"] is None and r["tests"]["timing"]["pass"] is None


def test_power_note_for_window_a():
    assert "13 months" in P.power_note(13)


# ---------------------------------------------------------------- TimesFM guard (no weights loaded)
@pytest.mark.parametrize("bad", ["google/timesfm-3.0-pytorch", "Google/TimesFM_3.0-pytorch", "someone/timesfm3-mirror"])
def test_timesfm_3_is_refused(bad):
    with pytest.raises(ValueError, match="non-commercial"):
        TF.check_repo_id(bad)


def test_only_the_pinned_2_5_checkpoint_is_accepted():
    assert TF.check_repo_id(TF.REPO_ID) == "google/timesfm-2.5-200m-pytorch"
    with pytest.raises(ValueError):
        TF.check_repo_id("google/timesfm-2.0-500m-pytorch")
    assert TF.forecast_config_kwargs(512)["infer_is_positive"] is False


def test_timesfm_smoke_if_installed():
    pytest.importorskip("timesfm")
    pytest.skip("weights are never downloaded in CI; run scripts/run_timesfm.py locally")


def test_runner_on_the_synthetic_fixture(tmp_path):
    import importlib.util
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("run_timesfm", root / "scripts" / "run_timesfm.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = tmp_path / "r.json"
    assert mod.main(["--data", str(root / "tests/fixtures/crosscheck-dataset.json"), "--out", str(out)]) == 0
    import json
    r = json.loads(out.read_text())
    assert r["input"]["synthetic"] is True and len(r["input"]["sha256"]) == 64
    assert set(r["windows"]) == {"A", "B", "C"}
