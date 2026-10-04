// How firmly each number or rule we use is established, summarized from the project's research notes
// (research/parameters.md, accessed 2026-09-30). Levels:
//   paper       confirmed from the paper's own text (the version read is named)
//   publisher   confirmed from the data publisher's own documentation
//   secondary   confirmed only from a secondary source (named)
//   unverified  could not be confirmed
//   adaptation  our own choice, needed because our data differ from the paper's
export const LEVELS = {
  paper: { label: 'Paper text', explain: 'Confirmed from the paper’s own text (the version read is named).' },
  publisher: { label: 'Publisher page', explain: 'Confirmed from the data publisher’s documentation.' },
  secondary: { label: 'Secondary source', explain: 'Confirmed only from a secondary source, which is named.' },
  unverified: { label: 'Unverified', explain: 'Could not be confirmed. Treat with caution.' },
  adaptation: { label: 'Our adaptation', explain: 'Our choice, because monthly industry data differ from the paper’s data.' },
};

export const CONFIRMATION = [
  // Strategies
  { group: 'buy-hold-market', item: 'Market return = Mkt−RF + RF', value: 'value-weighted CRSP market', level: 'publisher', where: 'Kenneth R. French Data Library, Fama/French factors page' },
  { group: 'equal-weight', item: 'The 1/N rule', value: 'w = 1/N, rebalanced', level: 'paper', where: 'DeMiguel, Garlappi & Uppal, 2006 NBER working paper (published RFS version not read)' },
  { group: 'equal-weight', item: 'Universe', value: 'French industry portfolios', level: 'adaptation', where: 'DGU test several datasets' },
  { group: 'faber-sma', item: 'Moving-average length', value: '10 months, simple', level: 'paper', where: 'Faber, “Step 2 – Manage your risk” (2013 update read; 2007 journal text not read)' },
  { group: 'faber-sma', item: 'Checked once a month, at month end', value: 'monthly', level: 'paper', where: 'Faber, Step 2 (2013 update)' },
  { group: 'faber-sma', item: 'Signal series: price or total return?', value: 'total-return index here', level: 'unverified', where: 'The paper says “price” but never says which series the average uses' },
  { group: 'faber-sma', item: 'Cash when out of the market', value: '1-month T-bill here (paper: 90-day T-bills)', level: 'adaptation', where: 'Faber, Step 2' },
  { group: 'tsmom', item: 'Lookback k, holding period', value: 'k = 12, hold 1 month', level: 'paper', where: 'Moskowitz, Ooi & Pedersen (2012), Sec. 4.1' },
  { group: 'tsmom', item: 'Volatility target', value: '40% per instrument', level: 'paper', where: 'MOP Sec. 4.1, Eq. (5)' },
  { group: 'tsmom', item: 'Exponentially weighted variance', value: 'Eq. (1)', level: 'paper', where: 'MOP Sec. 2.4' },
  { group: 'tsmom', item: 'Center of mass of the weights', value: '60 trading days in the paper; 3 months here', level: 'adaptation', where: 'MOP use daily returns; only monthly returns are available here' },
  { group: 'tsmom', item: 'Annualization factor', value: '261 (daily) in the paper; 12 here', level: 'adaptation', where: 'MOP Eq. (1)' },
  { group: 'tsmom', item: 'Minimum history before trading', value: '24 months', level: 'adaptation', where: 'Not stated by MOP for monthly data' },
  { group: 'xs-momentum', item: 'Formation J and holding K', value: 'J, K ∈ {3, 6, 9, 12}; headline 6/6', level: 'paper', where: 'Jegadeesh & Titman (1993), Sec. I and Table I' },
  { group: 'xs-momentum', item: 'Overlapping portfolios (1/K re-formed monthly)', value: 'K cohorts', level: 'paper', where: 'Jegadeesh & Titman, Sec. I' },
  { group: 'xs-momentum', item: 'Skip between formation and holding', value: 'one WEEK in JT Panel B; no skip here', level: 'paper', where: 'JT Table I; a one-week skip cannot be done with monthly data' },
  { group: 'xs-momentum', item: 'Industry version: top 3 vs bottom 3 industries', value: 'n = 3', level: 'secondary', where: 'Moskowitz & Grinblatt (1999), via Grobys & Kolari (2019) and a UCLA Anderson summary; paper not read' },
  { group: 'xs-momentum', item: 'Number of industries in MG', value: '20 (theirs); French 12 here', level: 'secondary', where: 'Grobys & Kolari (2019)' },
  { group: 'xs-momentum', item: 'Does MG’s headline strategy skip a month?', value: '—', level: 'unverified', where: 'Not confirmed from any source' },
  { group: 'xs-momentum', item: 'Carhart 12−2 window (months t−12 to t−2)', value: 'preset', level: 'paper', where: 'Carhart (1997), footnote 3' },
  { group: 'xs-momentum', item: 'Equal weights within each leg', value: '±1/n', level: 'adaptation', where: 'Our choice' },
  { group: 'st-reversal', item: 'Industries show 1-month momentum, not reversal', value: '≈ 105 bp/month (MG Table 3)', level: 'secondary', where: 'Grobys & Kolari (2019) citing MG Table 3' },
  { group: 'st-reversal', item: 'Industries per leg', value: 'n = 3', level: 'adaptation', where: 'Matches the momentum card' },
  { group: 'mean-variance', item: 'Estimation window M', value: '60 and 120 months, rolling', level: 'paper', where: 'DGU 2006 working paper, Sec. 3' },
  { group: 'mean-variance', item: 'Weights Σ̂⁻¹μ̂ / 1ᵀΣ̂⁻¹μ̂', value: 'Sec. 1', level: 'paper', where: 'DGU 2006 working paper (no absolute value printed)' },
  { group: 'mean-variance', item: 'Absolute value in the denominator (published version)?', value: '—', level: 'unverified', where: 'The published RFS text could not be read' },
  // Metrics
  { group: 'metrics', item: 'Sharpe ratio standard error √((1 + SR²/2)/T)', value: 'Eq. (9)', level: 'paper', where: 'Lo (2002)' },
  { group: 'metrics', item: 'Autocorrelation-adjusted annualization η(q)', value: 'Eq. (20)', level: 'paper', where: 'Lo (2002)' },
  { group: 'metrics', item: 'PSR uses √(T−1)', value: 'T−1', level: 'secondary', where: 'portfoliooptimizer.io plus internal consistency with Eq. (13); check the PDF by eye' },
  { group: 'metrics', item: 'PSR/DSR kurtosis is raw (normal = 3)', value: 'raw', level: 'paper', where: 'Bailey & López de Prado: only raw kurtosis reproduces their own numbers' },
  { group: 'metrics', item: 'Deflated Sharpe formula', value: 'Eqs. (1)–(2)', level: 'paper', where: 'Bailey & López de Prado (2014), 2014 preprint' },
  { group: 'metrics', item: 'DSR worked example (≈ 0.9004)', value: 'N = 100, V = 0.5', level: 'secondary', where: 'Author’s companion slides; recomputed exactly here' },
  { group: 'metrics', item: 'Downside deviation divides by all T months', value: '“full” method', level: 'secondary', where: 'R PerformanceAnalytics documentation' },
  { group: 'metrics', item: 'Sortino & Price (1994) exact definition', value: '—', level: 'unverified', where: 'Paper paywalled; not read' },
  { group: 'metrics', item: 'Turnover Σ|target − drifted weight|', value: 'Eq. (13)', level: 'paper', where: 'DGU 2006 working paper' },
  { group: 'metrics', item: 'Certainty equivalent with γ = 1', value: 'Eq. (12)', level: 'paper', where: 'DGU 2006 working paper' },
  { group: 'metrics', item: 'Ledoit & Wolf recommend a studentized bootstrap', value: '—', level: 'secondary', where: 'RePEc abstract; full text not read' },
  { group: 'metrics', item: 'Ledoit & Wolf’s kernel and bandwidth', value: '—', level: 'unverified', where: 'Not confirmed; ours is a Bartlett kernel' },
  { group: 'metrics', item: 'Lag rule ⌊4(T/100)^(2/9)⌋', value: 'Bartlett rule of thumb', level: 'secondary', where: 'Wooldridge textbook; Lazarus, Lewis, Stock & Watson (2018). Attribution to Newey & West (1994) is unverified' },
  // Market making
  { group: 'ggr-pairs', item: 'Formation 12 months, trading 6 months', value: 'F = 12, T_r = 6', level: 'paper', where: 'Gatev, Goetzmann & Rouwenhorst, NBER working paper w7032 (1999), p. 6; published RFS (2006) version not read' },
  { group: 'ggr-pairs', item: 'Normalized prices = cumulative total-return index; partner = minimum sum of squared deviations', value: '—', level: 'paper', where: 'GGR w7032, p. 7' },
  { group: 'ggr-pairs', item: 'Open when prices diverge by more than two historical standard deviations, estimated in formation', value: 'k = 2', level: 'paper', where: 'GGR w7032, pp. 7–8' },
  { group: 'ggr-pairs', item: 'Standard deviation of WHAT (we use the gap between normalized prices, ddof = 1)', value: '—', level: 'unverified', where: 'Our reading; the estimator is not spelled out in the text read' },
  { group: 'ggr-pairs', item: 'Close at the next crossing; close at the end of the trading period otherwise', value: '—', level: 'paper', where: 'GGR w7032, p. 8' },
  { group: 'ggr-pairs', item: 'Top 5 and top 20 pairs', value: 'n = 5', level: 'paper', where: 'GGR w7032, p. 8' },
  { group: 'ggr-pairs', item: 'Return on committed capital = sum of pair payoffs / number of pairs', value: '—', level: 'paper', where: 'GGR w7032, p. 9' },
  { group: 'ggr-pairs', item: 'A new portfolio starts every month; overlapping portfolios averaged', value: '—', level: 'paper', where: 'GGR w7032, p. 9 (averaging read as equal weights)' },
  { group: 'ggr-pairs', item: 'Monthly checks on industry portfolios (paper: daily, individual stocks)', value: '—', level: 'adaptation', where: 'Only monthly data are used here' },
  { group: 'ggr-pairs', item: 'Re-normalize prices to 1 at the start of trading', value: '—', level: 'unverified', where: 'Our choice; not stated in the text read' },
  { group: 'overfitting', item: 'CSCV: S blocks, all C(S, S/2) in-sample/out-of-sample splits, in-sample winner, relative rank ω = rank/(N+1), λ = ln(ω/(1−ω)), PBO = share of λ ≤ 0', value: 'Sec. 2', level: 'secondary', where: 'Bailey, Borwein, López de Prado & Zhu (2017). The full text could not be re-read in this build; the steps follow the paper’s published summary and the R package pbo. Verify before relying on edge cases (ties, λ = 0).' },
  { group: 'overfitting', item: 'S = 16 (12,870 splits) as the default', value: 'S = 16', level: 'secondary', where: 'Same as above' },
  { group: 'overfitting', item: 'Drop the first T mod S months so the blocks are equal', value: '—', level: 'adaptation', where: 'Our choice; the paper assumes T divisible by S' },
  { group: 'inverse-vol', item: 'Inverse-volatility weights equal the equal-risk-contribution portfolio when all correlations are equal', value: '—', level: 'secondary', where: 'Standard result attributed to Maillard, Roncalli & Teïletche (2010); the paper text was not read in this build' },
  { group: 'inverse-vol', item: 'Volatility window M = 36 months', value: 'M = 36', level: 'adaptation', where: 'Our choice; no published default for this use' },
  { group: 'models', item: 'Model definitions (random walk, Student t, Merton jumps, GARCH(1,1), GJR-GARCH, two-state Markov switching)', value: '—', level: 'secondary', where: 'Standard textbook forms of the cited papers (Bachelier 1900; Blattberg & Gonedes 1974; Merton 1976; Bollerslev 1986; Glosten, Jagannathan & Runkle 1993; Hamilton 1989); the original texts were not read in this build. Every estimator is checked by recovering known parameters from simulated data.' },
  { group: 'models', item: 'Stylized facts checked (heavy tails, asymmetry, no linear autocorrelation, volatility clustering, leverage effect, aggregational Gaussianity)', value: '—', level: 'secondary', where: 'The list follows Cont (2001); the exact statistics used for each fact are this project’s choices (ENGINE_SPEC §9.1)' },
  { group: 'models', item: 'Averaging prices within a month adds lag-1 autocorrelation of about 0.25 to a random walk', value: '≈ 0.25', level: 'secondary', where: 'Working (1960), reference details from a secondary source; reproduced by simulation in tests/js/markets.test.mjs' },
  { group: 'timing', item: 'Sharpe (1975): annual stock/cash switching, 1929–1972, needs about 7 right calls in 10', value: '≈ 70%', level: 'secondary', where: 'Buzzacchi & Ghezzi (2021, JRFM) and Damodaran’s lecture notes; the original paper could not be read' },
  { group: 'timing', item: 'CAPE rule: 6-month lag, expanding median, ≥ 120 months of history', value: '—', level: 'adaptation', where: 'Our choices; the lag reduces (but may not fully remove) look-ahead from interpolated earnings and late-published CPI; Campbell & Shiller (1998) study valuation ratios, not this exact rule' },
  { group: 'timing', item: 'Shiller prices: monthly averages of daily closes (his note, written through January 2000); dividends and earnings: four-quarter totals since 1926, annual before, interpolated; no short rate', value: '—', level: 'publisher', where: 'Shiller’s data notes as reproduced in the datasets/s-and-p-500 README' },
  { group: 'execution', item: 'Almgren–Chriss E(x), V(x), optimal trajectory and κ equation; Table 1 example parameters', value: 'Eqs. 5, 8, 17; Table 1', level: 'paper', where: 'Authors’ December 2000 manuscript (smallake.kr copy); the Journal of Risk version was not read' },
  { group: 'avellaneda-stoikov', item: 'Reservation price r = s − qγσ²(T−t)', value: 'Eq. (8)/(29)', level: 'paper', where: 'Avellaneda & Stoikov (2008)' },
  { group: 'avellaneda-stoikov', item: 'Spread γσ²(T−t) + (2/γ) ln(1 + γ/k)', value: 'Eq. (30)', level: 'secondary', where: 'Text extraction was garbled; this reading is the only one that reproduces the paper’s average spreads (1.49, 1.35, 3.02), and a Stanford MS&E 448 report agrees' },
  { group: 'avellaneda-stoikov', item: 'Simulation settings s₀ = 100, T = 1, σ = 2, dt = 0.005, k = 1.5, A = 140', value: 'Sec. 3.3', level: 'paper', where: 'Avellaneda & Stoikov (2008)' },
  { group: 'avellaneda-stoikov', item: 'Benchmark “symmetric” strategy: the inventory strategy’s AVERAGE spread, centred on the mid price', value: 'Sec. 3.3', level: 'paper', where: 'Avellaneda & Stoikov (2008), quoted: “uses the average bid/ask spread of the inventory strategy over the time period, but centres it round the mid-price”' },
  { group: 'avellaneda-stoikov', item: 'Results Tables 1–3', value: '1000 paths each', level: 'paper', where: 'Avellaneda & Stoikov (2008)' },
];

export const GROUP_LABEL = {
  'buy-hold-market': 'Buy and hold the market', 'equal-weight': '1/N equal weight', 'faber-sma': 'Moving-average timing (Faber)',
  tsmom: 'Time-series momentum', 'xs-momentum': 'Cross-sectional momentum', 'st-reversal': 'Short-term reversal',
  'mean-variance': 'Sample mean-variance', 'ggr-pairs': 'Pairs trading (distance method)', 'inverse-vol': 'Inverse-volatility weights', models: 'How markets move (models)', timing: 'Market timing', execution: 'Optimal execution (atlas)', overfitting: 'Probability of backtest overfitting', metrics: 'Metrics and tests', 'avellaneda-stoikov': 'Avellaneda–Stoikov market making',
};
