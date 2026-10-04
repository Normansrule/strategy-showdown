# Engine specification

This is the contract the JavaScript engine (`docs/engine/`) implements and the independent Python reference
implementation (`tests/python/reference.py`) re-implements from this document alone. The two must agree to
within floating-point tolerance on every number below; `tests/` enforces it.

## 1. Data

A dataset is monthly. Row `i` has a date `YYYY-MM` and, for that month:

| Field | Meaning |
|---|---|
| `rf[i]` | One-month T-bill return (French library `RF`), decimal |
| `market[i]` | Value-weighted US market total return = `Mkt-RF + RF`, decimal |
| `assets[name][i]` | Total return of each asset portfolio (industry portfolios), decimal |
| `factors.MktRF/SMB/HML/Mom[i]` | Fama–French and momentum factors, decimal (optional) |

Validation: dates strictly increasing and well formed; every series the same length; every value finite and
in (−1, 10]. The dataset fingerprint is SHA-256 of canonical JSON (sorted keys) of
`{dates, rf, market, assets, factors}`.

## 2. Universe and timing

- Universe: `U = [Market, asset_1, …, asset_N]`.
- A strategy decides at the END of month `t` using rows `0..t` only (the engine passes arrays truncated at `t`),
  returning target weights `w_t` over `U`. These earn month `t+1` returns.
- Money not in risky assets is in T-bills. For any weights:
  `excess_{t+1} = Σ_j w_{t,j} (r_{j,t+1} − rf_{t+1})` and gross total return `rf_{t+1} + excess_{t+1}`.
  (Long-only fully invested: identical to `Σ w r`. Long-short: an overlay on T-bill collateral.)

## 3. Common evaluation window (identical conditions)

- Each strategy has `warmup(params)` = number of rows it needs (see §6).
- `maxWarm = max over the compared strategies`. `startIdx` = first row with date ≥ requested start (default 0).
- `firstEval = max(startIdx, maxWarm)`; `endIdx` = last row with date ≤ requested end (default last row).
- Decisions are made at `t = firstEval−1, …, endIdx−1`; evaluated returns are months `firstEval..endIdx`.
- Requires `endIdx − firstEval ≥ 11` (at least 12 evaluated months).
- Every run in a comparison carries the same **conditions** object
  `{dataset, datasetFingerprint, universe, universeNote, evalStart, evalEnd, rebalance, costs, startingPosition}`
  and its SHA-256 hash. The runner refuses to compare runs with different hashes and names the differing fields.

## 4. Accounting per month (decision at t, return at t+1)

```
drifted_0 = 0 vector (start in T-bills)
turnover_t   = Σ_j |w_{t,j} − drifted_{t,j}|                 (one-way; DeMiguel et al. Eq. 13 style, incl. Market)
tradeCost_t  = turnover_t × tradeCostBps / 1e4
borrow_t     = Σ_j max(−w_{t,j}, 0) × borrowBpsPerYear / 1e4 / 12
excess       = Σ_j w_{t,j} (r_{j,t+1} − rf_{t+1})
net_{t+1}    = rf_{t+1} + excess − borrow_t − tradeCost_t
excessNet    = net − rf_{t+1}
grossExcess  = excess − borrow_t                               (before trading costs; used for break-even)
V            = 1 + rf_{t+1} + excess − borrow_t
drifted_{t+1,j} = w_{t,j} (1 + r_{j,t+1}) / V
grossExposure = Σ_j |w_{t,j}|,  netExposure = Σ_j w_{t,j}
```

**Ruin:** if `net ≤ −1`, set `net = −1`, record `ruinedAt`, and for every later month: `net = 0`,
`excessNet = grossExcess = −rf`, turnover, costs and exposures 0.

Cost presets (ASSUMPTIONS, adjustable): naive `{0 bps, 0 bps/yr}`; realistic `{10 bps per unit one-way turnover,
50 bps/yr borrow on short positions}`.

## 5. Metrics (q = 12 periods per year; `ex` = excessNet)

| Metric | Formula |
|---|---|
| totalReturn | `Π(1+net) − 1` |
| cagr | `(Π(1+net))^(q/T) − 1` |
| annMeanExcess | `mean(ex)·q` |
| annVol | `std(ex, ddof=1)·√q` |
| sharpePerPeriod | `mean(ex)/std(ex, ddof=1)` |
| sharpe | `sharpePerPeriod·√q` |
| sharpeCI (95%) | `(SR ± z·SE)·√q`, `SE = √((1 + SR²/2)/T)` (Lo 2002 Eq. 9), `z = Φ⁻¹(0.975)` |
| sharpeLoAdjusted | `SR·η(q)`, `η(q) = q / √(q + 2 Σ_{k=1}^{q−1} (q−k) ρ_k)` (Lo 2002 Eq. 20), `ρ_k` = sample autocorrelation of `ex` (autocovariance and variance both ÷ T) |
| sortino | `mean(ex)/DD·√q`, `DD = √(Σ min(ex,0)² / T)` (MAR = T-bill); undefined (NaN) when DD = 0 |
| maxDrawdown | `min_t (W_t / max_{s≤t} W_s − 1)`, `W` = wealth index of `net` starting at 1 (peak initialised at 1) |
| longestUnderwater | longest run of consecutive months with drawdown < 0 |
| hitRate | share of months with `ex > 0` |
| skew | population skewness of `ex` (bias=True) |
| kurtosis | RAW population kurtosis of `ex` (normal = 3) |
| psrVsZero | `Φ[ SR·√(T−1) / √(1 − skew·SR + (kurt−1)/4·SR²) ]` (Bailey & López de Prado 2012 Eq. 11) |
| ceq | `(mean(ex) − ½·var(ex, ddof=1))·q` (γ = 1) |
| annTurnover | `mean(turnover)·q` |
| avgGrossExposure / avgNetExposure | means of the exposure series |
| breakEvenCostBps | `mean(grossExcess)/mean(turnover)·1e4` (∞ if mean turnover is 0) |

**Deflated Sharpe (per comparison):** `trials` = per-period Sharpe ratios of every configuration tried (at least the
runs shown). `N = len(trials)`, `V = var(trials, ddof=1)`,
`SR0 = √V·((1−γ_E)Φ⁻¹(1−1/N) + γ_E Φ⁻¹(1−1/(N·e)))`, `DSR = PSR(SR0)` using each run's own T, skew, raw kurtosis.
Undefined (null) when N < 2.

**Sharpe-difference test vs benchmark:** delta method on `v = (μa, μb, E[a²], E[b²])` (population moments ÷ T),
`Δ = μa/√(E[a²]−μa²) − μb/√(E[b²]−μb²)`, gradient
`(E[a²]/sa^{3/2}, −E[b²]/sb^{3/2}, −μa/(2 sa^{3/2}), μb/(2 sb^{3/2}))` with `s = E[x²] − μ²`,
HAC long-run covariance Ψ of `y_t = (a−μa, b−μb, a²−E[a²], b²−E[b²])` with Bartlett weights `1 − l/(L+1)`,
`Γ_l = (1/T) Σ_{t=l}^{T−1} y_t y_{t−l}ᵀ`, `Ψ = Γ_0 + Σ_{l=1}^{L} w_l (Γ_l + Γ_lᵀ)`, `L = ⌊4(T/100)^{2/9}⌋`,
`SE = √(∇ᵀΨ∇ / T)`, two-sided normal p-value.

**Factor attribution:** OLS of `ex` on `[1, MktRF, SMB, HML, Mom]` (those present) with Newey–West Bartlett HAC
covariance (same weights and `L` rule, meat `S = Σ_l w_l Σ_t u_t u_{t−l} (x_t x_{t−l}ᵀ + x_{t−l} x_tᵀ)` for l>0,
no small-sample correction). `R² = 1 − SSR/SST`.

**Correlation:** Pearson correlation of `ex` between runs.

## 6. Strategies

`N` = number of assets; `c(r, a, b)` = `Π_{i=a..b}(1 + r_i) − 1`.

| id | warmup | weights at decision t |
|---|---|---|
| `buy-hold-market` | 1 | Market = 1 |
| `equal-weight` | 1 | each asset `1/N` |
| `faber-sma` (L=10) | L | `P_i = Π_{u=t−L+1..i}(1+market_u)` for `i = t−L+1..t`; Market = 1 if `P_t > mean(P)` else 0 |
| `tsmom` (lookback=12, targetVol=0.40, com=3) | max(lookback, 24) | per asset j: `x_i = r_{j,i} − rf_i`; `signal = sign(Π_{i=t−lookback+1..t}(1+x_i) − 1)`; `δ = com/(1+com)`; weights `ω_i = (1−δ)δ^i` for lags `i = 0..min(t, ⌈ln(1e−12)/ln δ⌉)`; `x̄ = Σω_i x_{t−i} / Σω_i`; `σ = √(12·Σω_i (x_{t−i}−x̄)² / Σω_i)`; `w_j = signal·targetVol/σ / N` (0 if σ = 0) |
| `xs-momentum` (J=6, K=6, skip=0, n=3) | J+skip+K−1 | average over cohorts `c = 0..K−1` of cohort weights; cohort c scores asset j by `c(r_j, t−c−skip−J+1, t−c−skip)`; rank descending (ties: lower asset index first); +1/n on top n, −1/n on bottom n; each cohort weighted 1/K |
| `st-reversal` (n=3) | 1 | as xs-momentum with J=1, K=1, skip=0 but direction reversed (−1/n on top n, +1/n on bottom n) |
| `mean-variance` (M=120) | M | excess returns of each asset over rows `t−M+1..t`; `μ̂` = sample mean; `Σ̂` = sample covariance (ddof=1); `raw = Σ̂⁻¹μ̂`; `w = raw / Σ raw` (singular = Gaussian elimination with partial pivoting meets a pivot with absolute value < 1e−14 → hold 1/N; if `|Σ raw| < 1e−12`: all 0) |
| `ggr-pairs` (F=12, Tr=6, n=5, k=2) | F+Tr−1 | see §6.1 |
| `inverse-vol` (M=36) | M | `sd_j` = sample sd (ddof = 1) of asset j's returns over rows `t−M+1..t`; `w_j = (1/sd_j) / Σ_i (1/sd_i)` (an asset with sd 0 gets 0; if every sd is 0: 1/N) |

Note on the ranking in `rankLongShort`: sort by score descending, ties by lower index first; top = first n,
bottom = last n. A weight may receive both +1/n and −1/n only if 2n > N.

### 6.1 `ggr-pairs`: distance-method pairs trading (Gatev, Goetzmann & Rouwenhorst)

Universe: the N assets (not the Market). Portfolio at decision t = average over cohorts `c = 0..Tr−1` of cohort
weights, each weighted `1/Tr`. Cohort c has formation end `e = t − c` (formation rows `e−F+1..e`, trading rows
`e+1..e+Tr`).

Cohort e:
1. Formation prices: `P_j(0) = 1`, `P_j(m) = Π_{u=1..m}(1 + r_{j, e−F+u})` for `m = 1..F`.
2. Distance: `SSD(i, j) = Σ_{m=1..F} (P_i(m) − P_j(m))²`.
3. Eligible pairs: for each asset i, its partner = `argmin_{j≠i} SSD(i, j)` (ties: lower j). Each eligible pair is
   stored once as (min index a, max index b). Sort eligible pairs by SSD ascending (ties: lower a, then lower b);
   keep the first n (fewer if fewer exist).
4. For each kept pair: `D_f(m) = P_a(m) − P_b(m)` for `m = 1..F`; `σ` = sample standard deviation (ddof = 1) of
   `D_f(1..F)`. If `σ = 0` the pair never opens.
5. Trading prices are re-normalized at e: `Q_j(e) = 1`, `Q_j(s) = Π_{u=e+1..s}(1 + r_{j,u})`. Spread
   `D(s) = Q_a(s) − Q_b(s)`.
6. Walk s = e, e+1, …, t (all s ≤ t, so only data through t are used). State: closed, or open with sign `g` and
   opening row `o`. At each s, in this order:
   - if open and (`D(s) = 0` or `sign(D(s)) ≠ g`): close;
   - if closed and `|D(s)| > k·σ`: open with `g = sign(D(s))`, `o = s`.
7. If open after s = t: the higher leg (a if g = +1, else b) gets `−(1/n)·Q_high(t)/Q_high(o)` and the lower leg
   gets `+(1/n)·Q_low(t)/Q_low(o)` (each leg is $1 per pair at opening, held without rebalancing; committed
   capital 1 per cohort split into n pairs). Otherwise the pair contributes 0.

The Market weight is 0. Cohort c = 0 (e = t) always has `D(t) = 0`, so it holds nothing at t.

## 7. Avellaneda–Stoikov simulation (docs/engine/sims/avellaneda-stoikov.js)

Paper Sec. 3.3 settings: `s0=100, T=1, σ=2, dt=0.005, q0=0, k=1.5, A=140`, 1000 paths, γ ∈ {0.1, 0.01, 1}.
Per step: spread `γσ²(T−t) + (2/γ)ln(1+γ/k)` (inventory strategy) or the constant time-average of that spread over the
session's steps (symmetric benchmark, paper Sec. 3.3: "uses the average bid/ask spread of the inventory strategy over the
time period, but centres it round the mid-price"); center = reservation price `s − qγσ²(T−t)` (inventory) or `s`
(symmetric); bid/ask = center ∓ spread/2; fill probabilities `min(1, A·e^{−kδ}·dt)` on each side;
then `s ← s ± σ√dt` with probability ½ each. Profit = cash + q·s_T.
Replication (seeds 1, 2, 42; 1000 paths): mean profits within 1.7 Monte Carlo standard errors of Tables 1–3, average
spreads within 0.012, standard deviations of profit and final inventory within 8% except one seed-2 case at 14%
(γ = 0.01 symmetric). The γ = 1 inventory row runs 2–8% low on both standard deviations for every seed tried; the
cause is not identified. Tests allow 3 s.e. on means, 0.02 on spreads and 15% on standard deviations.

## 8. Probability of backtest overfitting (docs/engine/overfit.js)

Input: a T×N matrix of per-period excess returns (column n = trial n, all on the same rows), and an even S ≥ 2.
1. Drop the first `T mod S` rows; split the remaining rows, in order, into S consecutive blocks of equal length
   `L = ⌊T/S⌋`.
2. For every combination c of S/2 block indices (lexicographic order over `{0..S−1}`): in-sample rows J = the
   union of the chosen blocks, out-of-sample rows J̄ = the rest.
3. Performance = per-period Sharpe ratio `mean / sd` (ddof = 1) of each column over J (vector R) and over J̄
   (vector R̄). If `sd ≤ 1e−12·max(|mean|, 1e−12)` (a numerically flat column), its Sharpe is 0. Inputs must be
   finite; S is limited to 2..20.
4. Ties use a tolerance ε = 1e−12, so rounding from summation order cannot change the outcome. `n*`: start at
   n = 0 and scan n = 1..N−1, moving to n whenever `R_n > R_{n*} + ε`. Rank of `R̄_{n*}` within R̄:
   `ρ = 1 + #{j ≠ n* : R̄_j < R̄_{n*} − ε} + ½·#{j ≠ n* : |R̄_j − R̄_{n*}| ≤ ε}`. Relative rank `ω = ρ/(N+1)`;
   logit `λ_c = ln(ω/(1−ω))`.
5. `PBO = #{c : λ_c ≤ 0} / #C`. Probability of loss = `#{c : R̄_{n*} < 0} / #C`. Performance degradation =
   least-squares line `R̄_{n*} = α + β·R_{n*}` across combinations (with R²).
Sharpe values are reported per period; display code annualizes by √12. Under pure noise the expected PBO is
`(N+1)/(2N)` for odd N (the median rank gives λ = 0, counted as overfit) and ½ for even N.

## 9. Price models and stylized facts (docs/engine/models.js)

Input: monthly simple returns `r_t`; models work on log returns `x_t = ln(1 + r_t)`, T months.

### 9.1 Stylized facts of a series x
`m`, `s` = mean and sample sd (ddof = 1). `ρ_k(y)` = sample autocorrelation (autocovariance and variance both divided by n).
- `volAnn = √12·s`; `skew`, `exKurt = kurtosisRaw − 3` (biased moment estimators, as in `mathx.js`)
- `tail3` = share of months with `|x_t − m| > 3s`
- `acf1 = ρ_1(x)`; `q12` = Ljung–Box `T(T+2)Σ_{k=1..12} ρ_k²/(T−k)`
- `absAcf` = mean of `ρ_k(|x|)` over k = 1..12; `leverage` = Pearson correlation of `x_t` with `|x_{t+1}|`
- `kurt12` = excess kurtosis of NON-overlapping 12-month sums (starting at month 0; a partial final block is dropped)
- `vr12` = variance (ddof 1) of OVERLAPPING 12-month sums / (12·s²)
- `maxDD` = largest fall of `exp(cumulative x)` from its running peak (peak starts at 1)

### 9.2 Models, likelihoods and fitting
All fits find a LOCAL maximum of the exact log-likelihood with Nelder–Mead (the jump and regime mixtures have unbounded likelihoods at degenerate points, so no global maximum exists) (reflection 1, expansion 2, contraction ½, shrink ½)
from the listed starts, each restarted once from its end point; the best end point wins. Parameters are
transformed to keep them valid (logs for scales, logistic for probabilities and persistence).
- `rw`: x ~ N(μ, σ²) i.i.d.; closed-form MLE (σ divides by T).
- `t`: x = μ + s·t_ν, ν > 2 (ν = 2 + e^θ).
- `jump` (Merton): density Σ_{k=0..K} Poisson(k; λ)·N(x; μ + kμ_J, σ² + kσ_J²), K = max(8, ⌈λ + 8√λ + 2⌉).
- `garch`: σ₁² = sample variance (divide by T); σ_t² = ω + α(x_{t−1} − μ)² + βσ_{t−1}²; α + β = 0.999·logistic(θ).
- `gjr`: as garch plus γ(x_{t−1} − μ)²·1[x_{t−1} < μ]; α + γ/2 + β < 0.999.
- `regime`: two Gaussian states, Markov switching with p₁₁, p₂₂; Hamilton filter started at the ergodic
  probabilities; state 1 is constrained to the lower σ (labels: calm, turbulent).
- `AIC = 2k − 2LL`, `BIC = k ln T − 2LL`.

### 9.3 Comparison
Each fitted model is simulated nSims times (default 200) for T months with `makeRng(seed + 7919·modelIndex)`;
GARCH-type models start at their unconditional variance, regime models at a state drawn from the ergodic
probabilities. For each fact the 5th, 50th and 95th percentiles across simulations are computed (linear
interpolation); the real value is "inside" if `lo ≤ real ≤ hi`, else "above"/"below". Tests check parameter
recovery for every estimator on long simulated samples and that a monthly-averaged random walk shows
lag-1 autocorrelation of about 0.25.

## 10. Shiller data (docs/engine/data/shiller.js)

Source: `datasets/s-and-p-500` on GitHub, file `data/data.csv`, pinned to commit
`07b81e6af68239acd65b901a11844d6d95db6ead` with SHA-256 `3a45dffa…ecac6`; never bundled. Rows are read until the
first row whose CPI or dividend is 0 or whose earnings are 0 (the packager's FRED-only extension after 2023-06);
`PE10 = 0` is read as missing. Total return `r_t = (P_t + D_t/12)/P_{t−1} − 1` (Shiller's notes: prices are monthly
averages of daily closes, as written for the data through January 2000; dividends are four-quarter totals since 1926,
annual Cowles totals before, interpolated to months). Cash return = 0 (no short rate in the data).

## 11. Market-timing simulations (docs/engine/timing.js)

Series: `ret[t]`, `cash[t]` per month (a leading null is skipped as 0 in rule contexts). Positions are 0 (cash) or
1 (market). Switching cost `c` bps per change of position, charged in the month the new position is held.
- **Skill timers:** each month, with probability p hold the better of (market, cash) for that month, else the
  worse; one `makeRng(seed)` stream for all timers. Share beating buy-and-hold = share with higher total
  log wealth. Break-even accuracy: the 50% crossing of that share on the grid p = 0.50, 0.51, …, 1.00 (the
  page interpolates linearly between grid points).
- **Missing months:** months ranked by `ret − cash`; the n best (or worst, or both) months earn cash instead.
- **Rules** (decide at the end of month t using rows ≤ t; for CAPE, a six-month lag REDUCES but may not remove look-ahead from interpolated earnings and late-published CPI; the context arrays grow by one row per step, so later
  rows cannot be read): `sma` (Faber: index of the last L = 10 returns above its own mean), `momentum` (12-month
  compounded return above compounded cash), `cape` (CAPE six months earlier below the median of all CAPE values
  up to that month, at least 120 values), `random` (one coin flip per month, `makeRng(7)`), `buy-hold`.
  All rules share one window starting at the first month every rule has a position.
- **Placebo:** random walks with the data's mean and sd of log returns (sd × √(3/2) when averaging, so the
  averaged series has about the data's variance), either month-end or averaged over 21 daily steps; the
  rules' CAGR minus buy-and-hold CAGR is summarized over the simulations.
- **Lump sum vs DCA:** for every window of M months, DCA invests 1/k of the money at the start of each of the
  first k months; uninvested money earns cash.

## 12. Optimal execution (docs/engine/execution.js)

Almgren & Chriss (2000), authors' December 2000 manuscript: `E(x) = ½γX² + εΣ|n_k| + (η̃/τ)Σn_k²` with
`η̃ = η − ½γτ` (eq. 8); `V(x) = σ²Σ_{k=1..N} τ x_k²` (eq. 5); optimal `x_j = sinh(κ(T − t_j))/sinh(κT)·X` (eq. 17)
with `(2/τ²)(cosh κτ − 1) = λσ²/η̃`; λ = 0 gives the straight line. Tests check the straight-line closed forms
(eqs. 10–11) and the paper's κ ≈ 0.6/day for its Table 1 parameters.
