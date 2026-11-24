# G3 spec: TimesFM as a published algorithm

Drafted 2026-11-11 at G0, with Grill Me findings at the end; G3 start notes (2026-11-24) in the last section. The harness lives in `timesfm_eval/` (the draft said `reference/timesfm/`, which would clash with `tests/python/reference.py`). Facts about the models come from the Hugging Face (HF) model cards and the google-research/timesfm README, read 2026-11-11 (see the G0 report).

## 1. Scope
- **Model:** TimesFM 2.5, `google/timesfm-2.5-200m-pytorch`, Apache-2.0 weights. Evidence label for the method: *paper* (Das, Kong, Sen & Zhou 2024, ICML, arXiv:2310.10688; DOI to check against Crossref). Evidence label for 2.5 specifics: *publisher* (model card).
- **TimesFM 3.0** (`google/timesfm-3.0-pytorch`, TimesFM Non-Commercial License v1.0): out of scope for every committed number. Optional local run only, user-downloaded, labelled "non-commercial licence; not part of the published record". None of its outputs go into the repo (see Grill Me Q3).
- **Python only:** `reference/timesfm/` (forecast runner) and later the desktop sidecar (G7). No JavaScript twin.
- **Not in scope:** Desk Brief (never), multivariate or covariate use, fine-tuning, daily-frequency trading.

## 2. Data
| Series | Source | Frequency | Use |
|---|---|---|---|
| Market excess return (Mkt-RF) and RF | Kenneth French Data Library, user-fetched, pinned, SHA-256 | monthly, 1926-07 onward | returns, direction, timing |
| Market daily returns | French daily factors, same rules | daily → monthly realized variance | volatility test |
| S&P composite total return | Shiller, user-fetched, pinned, SHA-256 | monthly, 1871 onward | returns, direction, timing (second market) |
| Synthetic | seeded generators already in the engine (i.i.d., AR(1), GARCH(1,1) paths) | monthly | CI fixtures and sanity checks |

- No FRED data is fed to TimesFM (FRED legal terms bar use "in connection with the development or training of any … machine learning"; inference is arguably outside that, but it is not worth the risk).
- Inputs: log excess returns for point and quantile forecasts; log realized variance for the volatility test. TimesFM normalises internally; we pass raw series and record that.

## 3. Walk-forward protocol
- At each month-end *t*: context = all observations through *t*, truncated to the most recent *C* points; forecast horizon *h* = 1 month (also *h* = 12 for the quantile and volatility diagnostics only). Decision for month *t*+1 uses only that forecast.
- Expanding origin, no refitting (zero-shot), so the only state is the context window.
- Primary configuration fixed in advance: *C* = 512, point forecast = model mean, band = 10th–90th quantile. Variant grid for PBO (Probability of Backtest Overfitting): *C* ∈ {128, 256, 512, 1024}, signal ∈ {mean > 0, median > 0, 30th quantile > 0}, cost ∈ engine default only → 12 variants. The grid is frozen in the spec before any real-data run.
- First forecast origin: after a 120-month burn-in, so every method (including GARCH and the historical mean) has the same evaluation months.

## 4. Leakage handling
The cards state cutoffs only for two sources: Wikimedia/Wikipedia pageviews (Nov 2023) and Google Trends (end of 2022). **GiftEvalPretrain and the synthetic/augmented data have no stated cutoff.** So:
- **Window A, "after release":** months after 2025-09-15 (TimesFM 2.5 release). Clean by construction. About 13 months today.
- **Window B, "after stated cutoff":** 2023-12 onward. Labelled "after the stated cutoffs; GiftEvalPretrain composition not verified".
- **Window C, full history:** labelled "possible pretraining overlap" everywhere it appears. Never a headline.
- **Prospective record:** from G3 merge, a monthly job (local, Alek runs it) appends the new forecast with timestamp, input hash and checkpoint hash to `data/timesfm-forecast-log.jsonl` before the outcome is known. This is the only truly out-of-sample record and the Forecast skill card shows it first.
- G3 must check GiftEvalPretrain's dataset list (primary source: the GIFT-Eval paper and HF dataset card) for French, Shiller, or S&P-derived series; if found, Window B is downgraded to "overlap".

## 5. Baselines
- Returns: random walk on price (forecast excess return = 0); historical mean (expanding, same burn-in).
- Direction: always-up (sign of the historical mean); coin flip only as a reference line.
- Volatility: GARCH(1,1) with normal innovations fitted on daily returns through *t*, aggregated to next-month variance; plus the naive "last month's realized variance". Needs the `arch` package (licence to verify at G3; not yet a dependency).
- Quantiles: empirical 10th/90th quantiles of the expanding window.

## 6. Metrics
- **MASE** (Mean Absolute Scaled Error, Hyndman & Koehler 2006, Crossref check) with the in-sample one-step naive scale; also MAE ratio vs each baseline.
- **Diebold–Mariano** test on squared and absolute loss differentials, HAC (heteroskedasticity- and autocorrelation-consistent) Newey–West variance.
- **Directional accuracy** with a Wilson 95% interval, compared with the break-even timing accuracy computed by `breakEvenAccuracy` on the *same window and costs* (not the site-wide ~61% / ~64% figures).
- **Volatility:** QLIKE and MSE on realized variance (Patton 2011, Crossref check), Diebold–Mariano vs GARCH.
- **Timing strategy:** positions from the frozen signal run through the existing JavaScript `applyPositions` with engine costs; Sharpe ratio, CAGR, max drawdown, switches; deflated Sharpe ratio with *N* = 12 trials; PBO via CSCV (combinatorially symmetric cross-validation) over the 12 variants.
- **Calibration:** 10–90% band coverage with a binomial interval (target 80%); hit rate per quantile; pinball loss vs the empirical-quantile baseline.

## 7. Fixtures and reproducibility
- Pin: `timesfm` PyPI version, HF revision (full commit hash; the card shows 1d95242, 2025-10-02), SHA-256 of `model.safetensors`, torch version, CPU only, float32, `torch.use_deterministic_algorithms(True)`, fixed thread count.
- Committed fixtures use **synthetic inputs only** (French and Shiller files must not be committed; CI already blocks them): input series, forecasts, quantiles, positions, metric values.
- CI: no weight download and no live calls. CI tests the metric code and the JS/Python cross-check (positions → `applyPositions` must match Python to 1e-9) using the recorded forecasts.
- Local reproducibility test (marked `@pytest.mark.timesfm`, skipped without weights): same machine, two runs → max abs difference ≤ 1e-6; recorded fixture vs fresh run → ≤ 1e-4. Tolerances are proposals until measured at G3 start; the measured spread goes into the spec.
- Real-data results: computed locally, committed as summary numbers plus input SHA-256 and checkpoint hash, so anyone with the same files can reproduce them.

## 8. Pass criteria (frozen before running; a fail is published as plainly as a pass)
| Test | TimesFM "shows skill" only if |
|---|---|
| Returns | DM test rejects equal loss vs **both** baselines at 5%, in Window B, and MASE < 1 |
| Direction | Wilson lower bound > measured break-even accuracy |
| Volatility | QLIKE lower than GARCH(1,1) with DM *p* < 0.05 |
| Timing strategy | deflated Sharpe probability > 0.95 **and** PBO < 0.5, after costs |
| Calibration | 80% band coverage interval contains 0.80 and pinball loss ≤ empirical baseline |

Power note to print next to every result: Window A has about 13 monthly observations. A Wilson 95% interval at 13 months is roughly ±25 percentage points, so no direction result in Window A can clear a 61% bar. Window A is shown, but it cannot pass or fail anything yet.

## 9. Deliverables
`reference/timesfm/` runner, metrics module and tests; fixtures; `docs/timesfm.html` (method, evidence labels, all three windows, power note); Forecast skill card data file; ENGINE_SPEC section; CHANGELOG entry.

## Grill Me pass
The Grill Me skill is not installed in this cloud session, so I ran its method by hand: hostile questions, an answer for each, and the ones only Alek can settle.

1. **"The cutoff is unknown, so isn't every historical result contaminated?"** Yes, possibly. Hence three windows, Window C never headlined, and the prospective log. *Settled in spec.*
2. **"13 clean months is nothing. Why ship G3 at all?"** Because the honest answer ("no detectable skill, and here is why we can't tell yet") is the product. *Alek: accept that the first published result will almost certainly be "inconclusive"?*
3. **"Can TimesFM 3 outputs go in the MIT repo?"** Its licence bars distributing Outputs for commercial or production purposes, and MIT lets downstream users do exactly that. Keep them out. *Settled; Alek confirm.*
4. **"Is the 12-variant grid itself a garden of forking paths?"** That is why PBO and deflated Sharpe use *N* = 12 and the grid is frozen now. Adding variants later resets *N* and is logged. *Settled.*
5. **"Why compare direction against the site's 61%/64% when windows differ?"** We don't; break-even is recomputed per window and cost. *Settled.*
6. **"Context 512 months is 42 years. Does the model care?"** Unknown; that's why *C* is in the grid. Primary *C* = 512 is a guess, said so. *Alek: OK with 512 as primary?*
7. **"GARCH needs `arch`, a new dependency."** It needs a licence check and a hash-locked entry in requirements-dev. *Check at G3.*
8. **"Could the prospective log be edited after the fact?"** Each entry carries the input hash and is committed via PR the same month; the git history is the timestamp. A stronger option is a signed tag per month. *Alek: is the PR history enough?*
9. **"Is running the model on user-fetched French data 'redistribution'?"** No data leaves the machine; only summary statistics are committed, the same rule the site already follows. *Settled.*
10. **"Will the sidecar break the 'network calls only in main' rule?"** The sidecar is a local child process on stdin/stdout with no network; weights are fetched once by main through the allowlist (`huggingface.co` and its CDN host, exact names to confirm). *Belongs in the G4 ADR.*

## G3 start notes (2026-11-24)

**Changed since G0 (PyPI, read 2026-11-24):** the `timesfm` package's latest release is 3.0.2 (uploaded 2026-09-09), and its
README now calls 2.5 an archived version. The 2.5 API (`timesfm.TimesFM_2p5_200M_torch`, `ForecastConfig`) is documented in
the README of `timesfm` **2.0.2** (uploaded 2026-07-02), so that is the pinned package (`timesfm[torch]==2.0.2`). The package
code is Apache-2.0 in every version; only the TimesFM 3.0 *weights* carry the non-commercial licence, and
`timesfm_eval/model.py` refuses any TimesFM 3 checkpoint id.

**`infer_is_positive` is off.** The README example turns it on; excess returns are often negative, so the harness sets it to
`False`.

**MASE on returns is an easy bar.** The one-step naive scale is the mean absolute *change* in monthly returns, which is
about √2 times their mean absolute deviation, so even the historical mean scores a MASE of about 0.7 to 0.8 on i.i.d. data (0.78 on the synthetic cross-check fixture). MASE < 1 is therefore a
necessary condition only; the Diebold–Mariano tests against both baselines carry the returns verdict.

**Open Grill Me questions, defaults taken until Alek says otherwise:** Q2 yes, publish "inconclusive" plainly; Q6 keep
*C* = 512 as primary; Q8 PR history is the timestamp for the prospective log.

**In this harness:** metrics (MASE, Diebold–Mariano with Newey–West variance and the Harvey–Leybourne–Newbold correction,
Wilson and Clopper–Pearson intervals, QLIKE, pinball loss), the walk-forward protocol, the random-walk and
historical-mean baselines, the three windows, the returns, direction and calibration verdicts, and
`scripts/run_timesfm.py`. **Not yet:** the volatility test (daily data plus a GARCH(1,1) baseline; the `arch` dependency
still needs its licence check), the timing test (positions through the JavaScript engine, deflated Sharpe and PBO over the
12 variants), the GiftEvalPretrain dataset-list check, the prospective log, and `docs/timesfm.html`.
