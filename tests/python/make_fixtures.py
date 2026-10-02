"""Generate the deterministic, SYNTHETIC test datasets used by the cross-language tests.

These are random numbers, not market data. They exist only so the JavaScript engine and the independent
Python reference can be run on identical inputs.

    python3 tests/python/make_fixtures.py

Writes tests/fixtures/crosscheck-dataset.json and tests/fixtures/stress-dataset.json.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
ASSETS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]


def month_dates(start_year: int, n: int) -> list[str]:
    return [f"{start_year + i // 12:04d}-{i % 12 + 1:02d}" for i in range(n)]


def fat_tail(rng, size, df=5):
    """Student-t shocks rescaled to unit variance."""
    return rng.standard_t(df, size=size) / np.sqrt(df / (df - 2))


def make_dataset(seed: int, T: int, *, equity_premium: float, alpha_scale: float, stress: bool) -> dict:
    rng = np.random.default_rng(seed)
    rf = np.clip(0.003 + 0.0005 * rng.standard_normal(T), 0.0, None)
    # Market excess: fat tails plus mild AR(1) so autocorrelation code paths are non-trivial.
    mkt_ex = np.empty(T)
    shock = 0.045 * fat_tail(rng, T)
    prev = 0.0
    for t in range(T):
        prev = equity_premium + 0.1 * (prev - equity_premium) + shock[t]
        mkt_ex[t] = prev
    N = len(ASSETS)
    betas = rng.uniform(0.6, 1.4, N)
    # Slowly varying asset-specific drifts (AR(1) with phi = 0.97) give persistent winners and losers
    # (momentum code paths); negative-phi idiosyncratic noise gives short-term reversal.
    drift = np.zeros((T, N))
    d = rng.normal(0, alpha_scale, N)
    for t in range(T):
        d = 0.97 * d + np.sqrt(1 - 0.97 ** 2) * rng.normal(0, alpha_scale, N)
        drift[t] = d
    idio = np.zeros((T, N))
    e_prev = np.zeros(N)
    eps = 0.03 * fat_tail(rng, (T, N))
    for t in range(T):
        e_prev = -0.15 * e_prev + eps[t]
        idio[t] = e_prev
    if stress:
        # Zero expected excess returns and highly correlated assets: the sample tangency denominator
        # 1'Σ̂⁻¹μ̂ wanders through zero, so mean-variance leverage explodes and the ruin rule fires.
        drift[:] = 0.0
        idio *= 0.25
    asset_ex = mkt_ex[:, None] * betas[None, :] + drift + idio
    r = lambda x: [round(float(v), 6) for v in x]
    market = np.clip(mkt_ex + rf, -0.95, 9.9)
    assets = {name: r(np.clip(asset_ex[:, j] + rf, -0.95, 9.9)) for j, name in enumerate(ASSETS)}
    factors = {
        "MktRF": r(market - rf),
        "SMB": r(0.02 * rng.standard_normal(T)),
        "HML": r(0.02 * rng.standard_normal(T) + 0.1 * (market - rf)),
        "Mom": r(0.03 * fat_tail(rng, T)),
    }
    return {
        "schema": 1,
        "id": "synthetic-stress" if stress else "synthetic-crosscheck",
        "title": ("Synthetic stress fixture (leverage blow-up)" if stress else "Synthetic cross-check fixture")
        + " — random numbers, not market data",
        "synthetic": True,
        "note": "test fixture, random numbers, not market data",
        "generator": f"tests/python/make_fixtures.py (numpy default_rng seed {seed})",
        "frequency": "monthly",
        "periodsPerYear": 12,
        "dates": month_dates(1990, T),
        "rf": r(rf),
        "market": r(market),
        "assets": assets,
        "factors": factors,
    }


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    base = make_dataset(20260930, 300, equity_premium=0.006, alpha_scale=0.004, stress=False)
    stress = make_dataset(7, 300, equity_premium=0.0, alpha_scale=0.0, stress=True)
    # Singular variant: asset Hotel duplicates Golf, so every sample covariance matrix is singular and the
    # mean-variance rule must fall back to 1/N (spec §6).
    singular = json.loads(json.dumps(base))
    singular["id"] = "synthetic-singular"
    singular["title"] = "Synthetic singular-covariance fixture (Hotel = Golf) — random numbers, not market data"
    singular["assets"]["Hotel"] = list(singular["assets"]["Golf"])
    for name, ds in (("crosscheck-dataset.json", base), ("stress-dataset.json", stress),
                     ("singular-dataset.json", singular)):
        (FIXTURES / name).write_text(json.dumps(ds, separators=(",", ":")) + "\n")
        print("wrote", FIXTURES / name)


if __name__ == "__main__":
    main()
