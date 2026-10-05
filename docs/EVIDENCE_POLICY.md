# Evidence policy

Strategy Showdown has one rule: **nothing unverifiable is presented as fact.** Every strategy, parameter,
formula and number on the site either points to a source that says it, or is labelled as our own choice,
an assumption, or unverified.

## 1. Evidence labels (strategy cards)

| Label | Meaning | Example |
|---|---|---|
| `published-replicable` | The method is public **and** can be re-run on data this project can use, so the paper's own numbers can be reproduced here. | Avellaneda–Stoikov simulation (Tables 1–3: means within 1.7 Monte Carlo s.e.; dispersion within about 8%, see ENGINE_SPEC §7) |
| `published-data-restricted` | The method is public, but the paper's data are licensed (e.g. CRSP stock-level data, futures). We apply the method to the data we have, so results **will differ** from the paper. | Jegadeesh–Titman momentum on industry portfolios |
| `public-description` | Only what a firm or person has said publicly about an approach. We never show code, parameters or performance for these as if they were the real thing. | (none yet) |
| `definition` | A benchmark defined by construction. It makes no empirical claim. | Buy and hold the market |

We never claim to reproduce any firm's proprietary algorithm. "Inspired by X" and "X's strategy" are not used.

## 2. Rules

1. **Defaults are the paper's values**, with the section, equation or table they come from shown next to the
   parameter (`source` field of each parameter).
2. **Every deviation is listed** on the card (`deviations` field): a different universe, frequency, data set or
   an estimator that monthly data forces us to change.
3. **Our own choices are labelled as ours** (e.g. equal weights within a leg, a 24-month warm-up).
4. **Assumptions are labelled as assumptions** (e.g. the "realistic" cost preset: 10 bps per unit of turnover and
   50 bps a year to borrow). Every run also reports the break-even cost at which its edge disappears.
5. **Citations are checked by machine.** Each DOI in `docs/data/citations.json` is compared with Crossref
   (title, year, first author, journal) weekly and on every change (`.github/workflows/citations.yml`).
   A mismatch fails the check.
6. **Where the version read differs from the published one, the card says which version was read**
   (e.g. a 2006 working paper, a 2013 update).
7. **Numbers from papers are only used as test targets after they have been reproduced** (see §4). Values that
   could not be reproduced are not used.
8. **Data provenance travels with the data.** Every dataset records its source files, their SHA-256, the CRSP
   vintage and how many months were dropped and why. Synthetic data are labelled on every screen.

## 3. Confirmation levels

- **paper**: read in the paper text (the version read is named).
- **secondary (named)**: confirmed only from the named secondary source.
- **reproduced**: confirmed because our implementation reproduces the paper's own reported numbers.
- **unverified**: could not be confirmed. Used only with that label, or not used.

Source of this table: the project's research notes (accessed 2026-09-30).

## 4. Parameters and formulas used

| Item | Value used | Source (location) | Level |
|---|---|---|---|
| **Faber** moving-average rule | Hold market if month-end level > 10-month SMA, else T-bills; checked monthly | Faber, 2013 update of the 2007 paper, "Step 2" | paper (2013 update; the 2007 journal text was not read) |
| Faber signal series | Total-return index (French data has no price-only series) | Paper does not say whether the SMA uses price or total return | **unverified / ambiguous**, flagged on the card |
| **MOP time-series momentum** | k = 12, h = 1, 40 % volatility target, Eq. (5) | Moskowitz, Ooi & Pedersen 2012, Sec. 4.1 | paper |
| MOP volatility estimator | EWMA, Eq. (1); paper uses daily data, A = 261, centre of mass 60 days | Sec. 2.4 | paper; our monthly adaptation (A = 12, centre of mass 3 months) is a **deviation** |
| **Jegadeesh–Titman** momentum | J, K ∈ {3, 6, 9, 12}; headline 6/6; overlapping cohorts | JT 1993, Sec. I, Table I | paper |
| JT skip | One **week** (Table I Panel B); monthly data cannot do this, default is no skip (Panel A) | Table I | paper; deviation flagged |
| **Moskowitz & Grinblatt** industry momentum | 20 value-weighted industries, top 3 vs bottom 3, 6/6 | Grobys & Kolari (2019); UCLA Anderson summary | **secondary**; whether MG's headline skips a month is **unverified** |
| MG 1-month industry momentum (not reversal) | 1-0-1 strategy ≈ 105 bp/month (their Table 3) | Grobys & Kolari (2019); AQR summary | **secondary** |
| Carhart PR1YR window | Months t−12 to t−2 | Carhart 1997, footnote 3 | paper |
| French library Mom | Mom = ½(Small High + Big High) − ½(Small Low + Big Low); 2×3 value-weighted sorts | Library page `det_mom_factor.html` | publisher page; checked monthly by the live-data job (§5) |
| **DeMiguel–Garlappi–Uppal** mean-variance | M = 60 or 120; w = Σ̂⁻¹μ̂ / 1ᵀΣ̂⁻¹μ̂ | **2006 NBER working paper** "1/N", Sec. 1 | paper (2006 WP; the published RFS text was not read). Whether RFS uses an absolute value in the denominator is **unverified** |
| DGU CEQ, turnover | CEQ = μ − γ/2·σ², γ = 1; turnover Eq. (13) | 2006 WP, Eqs. (12), (13) | paper (2006 WP) |
| **Lo (2002)** Sharpe SE and η(q) | SE = √((1 + SR²/2)/T), Eq. (9); η(q) Eq. (20) | Lo 2002 | paper |
| **PSR** | Φ[SR·√(T−1)/√(1 − γ₃SR + (γ₄−1)/4·SR²)], raw kurtosis | Bailey & López de Prado 2012, Eq. (11) | paper for the form; **T−1** from secondary (portfoliooptimizer.io) plus consistency with Eq. (13); raw kurtosis **reproduced** from the paper's MinTRL examples |
| **DSR** | PSR(SR₀), SR₀ from the expected maximum of N trials | Bailey & López de Prado 2014, Eqs. (1)–(2) | paper; **reproduced** worked example (DSR ≈ 0.9004) |
| **Sortino** | Downside deviation over all T months, MAR = T-bill | Sortino & Price 1994 | **secondary** (PerformanceAnalytics docs, Wikipedia); the paper text was not read |
| **Sharpe-difference test** | Delta method, Bartlett HAC, L = ⌊4(T/100)^(2/9)⌋ | Ledoit & Wolf 2008 discuss HAC as an alternative | Our documented choice. Their **recommended** method is a studentized block bootstrap (roadmap). Their kernel and bandwidth (reported as prewhitened quadratic-spectral) are **unverified** |
| **Newey–West lag rule** ⌊4(T/100)^(2/9)⌋ | Bartlett rule of thumb | Wooldridge (textbook), Lazarus, Lewis, Stock & Watson 2018 | **secondary**. Whether Newey & West (1994) print this exact rule is **unverified**; in NW 1994 a T^(2/9) term is the pilot lag, not the final bandwidth. Labelled "Bartlett rule of thumb (commonly attributed to Newey–West 1994)" |
| **Avellaneda–Stoikov** | Reservation price r = s − qγσ²(T−t); spread γσ²(T−t) + (2/γ)ln(1 + γ/k); A = 140, k = 1.5, σ = 2, dt = 0.005, 1000 paths | A–S 2008, Eqs. (29)–(30), Sec. 3.3 | paper for settings. Eq. (30) text extraction was garbled; the γσ²(T−t) reading is **reproduced** (spreads 1.49 / 1.35 / 3.02 match Tables 1–3; the 2γσ² reading does not) and matches a secondary source (Stanford MS&E 448 report) |
| **Gatev–Goetzmann–Rouwenhorst** pairs | Formation 12 months, trading 6, top 5 pairs, open at 2 historical σ, close at crossing, committed capital, monthly overlapping portfolios | GGR, NBER working paper w7032 (1999), pp. 6–9 | paper (1999 WP; the RFS 2006 text was not read). Which σ (we use the formation gap, ddof = 1) and re-normalizing at the start of trading are **unverified** choices; monthly checks on industries are an **adaptation** |
| **Probability of backtest overfitting** (CSCV) | S blocks, all C(S, S/2) splits, ω = rank/(N+1), λ = logit ω, PBO = share λ ≤ 0; S = 16 | Bailey, Borwein, López de Prado & Zhu 2017, Sec. 2 | **secondary** (published summary and the R package *pbo*); the full text could not be re-read in the build session. Dropping the first T mod S months is our **adaptation**. JS and Python implementations agree to 1e−9 on the tested sweeps (S = 6–16) |
| **Inverse-volatility weights** | w ∝ 1/σ̂ over 36 months | Maillard, Roncalli & Teïletche 2010 (equal-correlation special case of ERC) | **secondary** for the ERC link; the 36-month window is our **adaptation** |
| **Price models** (random walk, Student t, Merton jumps, GARCH(1,1), GJR-GARCH, 2-state regime switching) | Exact MLE, Nelder–Mead; facts checked against 5–95% simulation bands | Bachelier 1900; Blattberg & Gonedes 1974; Merton 1976; Bollerslev 1986; Glosten, Jagannathan & Runkle 1993; Hamilton 1989; Cont 2001 | **secondary** (textbook forms; originals not read). Estimators **reproduced** by parameter-recovery tests |
| **Shiller S&P Composite data** | Pinned commit + SHA-256; rows after 2023-06 dropped; cash = 0% | datasets/s-and-p-500 README (Shiller's notes) | **publisher** (packager's README); not redistributed |
| **Market-timing simulations** | Skill timers, missing months, rule-based timers, averaging placebo, lump sum vs DCA | ENGINE_SPEC §11; Sharpe 1975 context | Sharpe (1975) conclusion **secondary**; all rules and choices are ours and stated |
| **Almgren–Chriss execution** | Eqs. (5), (8), (17); Table 1 parameters | Authors' December 2000 manuscript | **paper** (manuscript); κ ≈ 0.6/day **reproduced** |
| Cost preset "realistic" | 10 bps per unit turnover, 50 bps/yr borrow | — | **assumption**, adjustable |

## 5. Data files

- **Source:** Kenneth R. French Data Library. File names and URLs (checked 2026-09-30 on the library page):
  `F-F_Research_Data_Factors_CSV.zip`, `12_Industry_Portfolios_CSV.zip`, `F-F_Momentum_Factor_CSV.zip`,
  `6_Portfolios_ME_Prior_12_2_CSV.zip`, all under `https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/`.
- **Not redistributed.** The library publishes no licence; see [DISCLAIMER.md](DISCLAIMER.md).
- **Layout** (how the parser expects the CSVs to look) was checked against **third-party copies** of real files
  (factors: 201909 vintage; 10 industries: 202607 vintage; 6 size/momentum portfolios: 201803 vintage), not
  against files downloaded from the library itself, which the development environment could not reach.
  The momentum-factor file (`F-F_Momentum_Factor`) layout was **not** seen; the parser treats it like the
  factors file (one column `Mom`).
- **The parser has not yet been run against live library files from the development environment.** The
  weekly live-data CI job (`.github/workflows/live-data.yml`) is the real test: it downloads the files, rebuilds
  Mom from the six portfolios and fails unless the maximum absolute difference is ≤ 0.00015 (what rounding of
  2-decimal percentages allows) and the correlation is ≥ 0.9999.
- Test fixtures in `tests/fixtures/french/` are **format fixtures with invented values**.
