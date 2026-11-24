"""Seeded synthetic monthly series for fixtures and CI (spec §2, §7). No real data is ever committed."""
from __future__ import annotations

import numpy as np


def months(start_year: int, n: int) -> list[str]:
    return [f"{start_year + i // 12:04d}-{i % 12 + 1:02d}" for i in range(n)]


def iid(n: int, mu: float = 0.006, sigma: float = 0.045, seed: int = 1) -> np.ndarray:
    return np.random.default_rng(seed).normal(mu, sigma, n)


def ar1(n: int, phi: float = 0.6, mu: float = 0.0, sigma: float = 0.02, seed: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = np.empty(n)
    x[0] = mu
    for t in range(1, n):
        x[t] = mu + phi * (x[t - 1] - mu) + rng.normal(0, sigma)
    return x


def garch(n: int, omega: float = 2e-5, alpha: float = 0.1, beta: float = 0.85, mu: float = 0.005, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h = omega / (1 - alpha - beta)
    x = np.empty(n)
    for t in range(n):
        e = np.sqrt(h) * rng.normal()
        x[t] = mu + e
        h = omega + alpha * e * e + beta * h
    return x
