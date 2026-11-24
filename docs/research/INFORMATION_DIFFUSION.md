# Information diffusion: what an individual investor can and cannot use

Status: research note and spec for `docs/engine/diffusion.js` (2026-11-24). Evidence labels follow
[EVIDENCE_POLICY.md](../EVIDENCE_POLICY.md). Nothing here is a recommendation. History is a base rate, not a forecast.

## 1. The question

Some trading profits come from learning information before the whole market has priced it. Two very different
things hide under that sentence:

- **Speed** (milliseconds to seconds): being first to act on news that everyone will see. Out of reach for an
  individual investor. Prices of SPY and the E-mini future respond to macroeconomic surprises within about five
  milliseconds, and fast-trading profits are small, about $19,000 (SPY) and $50,000 (E-mini) per announcement
  (Chordia, Green & Kottimukkalur 2018, abstract; label: paper, abstract only). See also Budish, Cramton & Shim (2015).
  On the floor this is an **explainer**, never a tradable edge.
- **Slow diffusion** (weeks to months): information that reaches prices gradually, because attention, coverage
  or processing are limited. This is the only part an individual could hope to use, because it rewards patience
  rather than speed. Whether it survives costs and publication is an empirical question, tested here.

## 2. The references Alek supplied (audited 2026-11-24)

| Reference | Licence | What we take |
|---|---|---|
| awesome-systematic-trading (link list + 62 QuantConnect ports of Quantpedia descriptions) | **No licence file**: all rights reserved | Nothing copied. Used only as an index to the original papers. Most of its strategies need CRSP/Compustat stock-level data we cannot redistribute. |
| World Monitor | **AGPL-3.0** | No code. Three design ideas, re-expressed in our own words: (1) point-in-time "as-of" reads, (2) a content-age clock per source, reporting the oldest when sources are combined, (3) a three-way read outcome (hit / miss / failure) where a failure abstains instead of showing an empty answer. Planned for G5. |

## 3. Spec: diagnostics on the 6 size/momentum portfolios (built now)

Data: French library `6_Portfolios_ME_Prior_12_2` (value-weighted, monthly, 2 size groups split at the NYSE
median × 3 prior-return groups, months −12 to −2), user-fetched, never committed. Columns used: small (low, mid,
high), big (low, mid, high), decimal returns on the dataset's months.

**3.1 Momentum by size** (Hong & Stein 1999; Hong, Lim & Stein 2000). Label `published-data-restricted`.
- `small_t = SmallHigh_t − SmallLow_t`, `big_t = BigHigh_t − BigLow_t`, `gap_t = small_t − big_t`.
- For each period: T, mean, 12 × mean, Newey–West (Bartlett, L = ⌊4 (T/100)^(2/9)⌋, no small-sample correction)
  standard error and t of the mean (OLS on a constant), share of months > 0.
- Default periods (McLean & Pontiff 2016 windows): whole sample; 1980-01..1996-12 (the HLS sample, per the NBER
  Digest, Nov 1998); 1997-01..2000-01 (after the sample, before publication); 2000-02 onward (after publication
  in the Journal of Finance, February 2000).
- Prediction under slow diffusion: gap > 0. Prediction under McLean–Pontiff: smaller after publication
  (their average across 97 predictors: 26% lower out of sample, 58% lower after publication; label: secondary,
  CFA Institute digest).
- Deviations: HLS use individual stocks in size deciles plus analyst coverage; two size halves dilute the effect
  (HLS's abstract says the decline with size holds apart from the very smallest stocks). Gross of costs.

**3.2 Lead-lag** (Lo & MacKinlay 1990). Label `published-data-restricted`; lead direction **unverified** here.
- `S_t` = equal average of the three small portfolios, `B_t` = same for big (our adaptation).
- For each period, over months t whose previous month is also in the period: corr(S_t, B_{t−1}),
  corr(B_t, S_{t−1}), corr(S_t, S_{t−1}), corr(B_t, B_{t−1}), asymmetry = first − second, corrSE = 1/√T, and
  HAC regressions S_t on [1, B_{t−1}, S_{t−1}] and B_t on [1, S_{t−1}, B_{t−1}] (our choice).
- Default periods: whole sample, before 1990, from 1990 (split at the publication year: our choice).
- Any period with fewer than 24 usable months is reported as unavailable, never computed.

Tests: `tests/js/diffusion.test.mjs` (JavaScript vs the Python reference `tests/python/reference.py` to 1e-9 on
a synthetic fixture with a planted lead; known answers; loader integration) and `tests/python/test_reference.py`.

**Real-data result: not yet run.** The cloud environment cannot reach the French library. Run locally:
`python3 scripts/fetch_french.py && node scripts/diffusion_report.mjs`. The result will be reported as it comes
out, including a null.

## 4. Roadmap (each item waits for its gate)

| Idea | Source (label) | Data | Gate | Honest expectation |
|---|---|---|---|---|
| Point-in-time macro: FRED vintages (ALFRED, `realtime_start`/`realtime_end`) so backtests use only what was known then | FRED API docs (publisher, to verify at G5) | FRED | G5 | Removes look-ahead; usually lowers backtest results |
| Per-source staleness clock (oldest wins) and hit/miss/failure reads | World Monitor concepts (idea only, AGPL) | all feeds | G5 | Hygiene, not alpha |
| Post-earnings-announcement drift (PEAD) from EDGAR XBRL earnings surprises | Bernard & Thomas 1989 (not read); Martineau 2022 (abstract: gone for large stocks since 2006) | EDGAR | G6 | Likely null for large stocks; show it plainly |
| "Lazy Prices": year-on-year 10-K text similarity | Cohen, Malloy & Nguyen 2020 (not read) | EDGAR | G6 | Unknown; publication decay expected |
| Speed explainer: why milliseconds are out of reach | Chordia et al. 2018; Budish et al. 2015 | none | G4/G5 explainer | Explainer only |

Out of reach, stated plainly: latency and order-flow edges, analyst-coverage sorts (no public coverage data),
supply-chain lead-lag (needs customer links data), and anything needing CRSP stock-level returns.
