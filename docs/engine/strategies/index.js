// Strategy cards: the published algorithms, implemented exactly as documented, with every deviation stated.
//
// Contract: weights(ctx) is called at the END of month t with data through month t only, and returns target
// weights over the universe [Market, asset_1..asset_N]. Those weights earn month t+1 returns. Anything not in
// risky assets sits in T-bills (earns rf). Long-short weights are overlays on a T-bill collateral account.
//
// Evidence labels (docs/EVIDENCE_POLICY.md):
//   'published-replicable'       method public AND reproducible on data we can use
//   'published-data-restricted'  method public; the paper's data is licensed, so our data differs
//   'public-description'         only what a firm says about itself; never code or parameters
//   'definition'                 a benchmark defined by construction (no empirical claim)

import { mean, covMatrix, invert } from '../mathx.js';

const cumulative = (arr, from, to) => { // compounded return of arr[from..to] inclusive
  let v = 1;
  for (let i = from; i <= to; i++) v *= 1 + arr[i];
  return v - 1;
};

function rankLongShort(scores, nLong, direction) {
  // direction +1: long highest scores (momentum); −1: long lowest (reversal). Ties broken by asset order.
  const idx = scores.map((s, i) => [s, i]).sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
  const top = idx.slice(0, nLong).map(x => x[1]);
  const bottom = idx.slice(-nLong).map(x => x[1]);
  const w = new Array(scores.length).fill(0);
  for (const i of top) w[i] += direction / nLong;
  for (const i of bottom) w[i] -= direction / nLong;
  return w;
}

export const STRATEGIES = [
  {
    id: 'buy-hold-market',
    name: 'Buy and hold the market',
    family: 'Baseline',
    evidence: 'definition',
    summary: 'Own the whole US stock market and never trade. The benchmark every active idea has to beat after costs.',
    intuition: 'No forecasting at all. If a strategy cannot beat this after costs and after accounting for the number of ideas tried, it has not shown skill.',
    equations: [
      { tex: 'r^{p}_{t+1} = r^{mkt}_{t+1}', where: 'The market return is the value-weighted CRSP market (Mkt−RF + RF in the French library).' },
    ],
    sources: [{ key: 'french_data_library', where: 'Fama/French factors: Mkt−RF and RF' }],
    deviations: [],
    failureModes: ['Full exposure to market crashes (for example 1973–74, 2000–02, 2008).'],
    params: {},
    warmup: () => 1,
    weights: () => ({ market: 1 }),
  },
  {
    id: 'equal-weight',
    name: '1/N equal weight',
    family: 'Baseline',
    evidence: 'published-data-restricted',
    summary: 'Split money equally across the N industry portfolios and rebalance monthly.',
    intuition: 'DeMiguel, Garlappi & Uppal (2009) found that this naive rule was hard to beat out of sample, because optimized portfolios need very long histories to estimate expected returns accurately.',
    equations: [
      { tex: 'w_{j,t} = \\tfrac{1}{N}, \\quad j = 1,\\dots,N', where: 'N = number of industry portfolios in the universe.' },
    ],
    sources: [{ key: 'demiguel2009naive', where: 'Sec. 1 (the 1/N rule); read from the 2006 working-paper version' }],
    deviations: ['Our universe is the French industry portfolios loaded here; DeMiguel et al. test several datasets.'],
    failureModes: ['Monthly rebalancing creates small turnover; it cannot avoid market-wide drawdowns.'],
    params: {},
    warmup: () => 1,
    weights: ctx => ({ assets: new Array(ctx.nAssets).fill(1 / ctx.nAssets) }),
  },
  {
    id: 'faber-sma',
    name: 'Moving-average timing (Faber)',
    family: 'Trend-following',
    evidence: 'published-data-restricted',
    summary: 'Hold the market when it is above its 10-month simple moving average; otherwise hold T-bills. Checked once a month.',
    intuition: 'A slow trend filter that tries to sidestep long bear markets, at the cost of some whipsaws.',
    equations: [
      { tex: '\\text{SMA}_t = \\tfrac{1}{L}\\sum_{i=0}^{L-1} P_{t-i}', where: 'P = month-end index level; L = 10 months.' },
      { tex: 'w^{mkt}_t = \\begin{cases} 1 & P_t > \\text{SMA}_t \\\\ 0 & \\text{otherwise (T-bills)} \\end{cases}', where: 'Evaluated on the last trading day of each month.' },
    ],
    sources: [{ key: 'faber2007tactical', where: '“Step 2 – Manage your risk” (read in the 2013 update of the paper)' }],
    deviations: [
      'Faber phrases the rule in terms of price but does not say whether the moving average uses a price or a total-return series (ambiguous in the paper). The French library provides total returns only, so P here is a total-return index.',
      'Faber times 5 asset classes (US stocks, foreign stocks, bonds, commodities, REITs); here it is applied to the US market only.',
      'When out of the market Faber holds 90-day Treasury bills; the French library supplies a 1-month T-bill rate, which is used here instead.',
    ],
    failureModes: ['Whipsaws in sideways markets', 'Sudden crashes inside a month are not avoided'],
    params: {
      L: { default: 10, min: 2, max: 24, step: 1, label: 'Moving-average length (months)', source: 'Faber: 10 months' },
    },
    warmup: p => p.L,
    weights: (ctx, p) => {
      const t = ctx.t;
      // Total-return index levels P_{t-L+1..t}, normalized to 1 at t-L.
      let level = 1;
      const levels = [];
      for (let i = t - p.L + 1; i <= t; i++) { level *= 1 + ctx.market[i]; levels.push(level); }
      const sma = mean(levels);
      return { market: levels[levels.length - 1] > sma ? 1 : 0 };
    },
  },
  {
    id: 'tsmom',
    name: 'Time-series momentum (MOP)',
    family: 'Trend-following',
    evidence: 'published-data-restricted',
    summary: 'For each industry: go long if its past 12-month excess return is positive, short if negative, sized to a 40% volatility target. Average across industries.',
    intuition: 'Each asset is judged against its own past, not against the others. Volatility scaling makes calm and wild assets contribute similar risk.',
    equations: [
      { tex: 'r^{TSMOM}_{t,t+1} = \\operatorname{sign}\\!\\left(r_{t-12,t}\\right)\\,\\frac{40\\%}{\\sigma_t}\\, r_{t,t+1}', where: 'MOP Eq. (5): r_{t−12,t} = past 12-month excess return; σ_t = ex-ante annualized volatility.' },
      { tex: '\\sigma_t^2 = A \\sum_{i\\ge 0} (1-\\delta)\\,\\delta^{i}\\,(r_{t-1-i} - \\bar r_t)^2, \\quad \\tfrac{\\delta}{1-\\delta} = \\text{center of mass}', where: 'MOP Eq. (1), as printed: exponentially weighted variance of DAILY returns up to day t−1, A = 261, center of mass 60 days. Our monthly adaptation is described under “How our version differs”.' },
      { tex: 'w_{j,t} = \\tfrac{1}{N}\\operatorname{sign}\\!\\left(r^{(j)}_{t-12,t}\\right)\\frac{40\\%}{\\sigma^{(j)}_t}', where: 'Diversified portfolio: equal-weighted average across the N assets.' },
    ],
    sources: [
      { key: 'moskowitz2012tsmom', where: 'Sec. 2.4 Eq. (1) volatility estimator; Sec. 4.1 Eq. (5) strategy' },
      { key: 'hurst2017century', where: 'Long-sample evidence for trend-following' },
    ],
    deviations: [
      'MOP trade 58 futures and forwards across asset classes; here the universe is US industry equity portfolios.',
      'MOP estimate volatility from DAILY returns (A = 261, center of mass 60 days). Only monthly data are available here, so A = 12 and the default center of mass is 3 months (≈ 60 trading days). This is an adaptation, not the paper’s estimator.',
      'MOP’s estimator (Eq. 1) sums r_{t−1−i}, i.e. daily returns up to the day before. Ours sums monthly r_{t−i}, i.e. it includes month t, the last month fully known when the month-t decision is made. Both use only past data; the indexing differs.',
      'Requiring 24 months of history before trading is our choice (MOP do not state a minimum for monthly data).',
    ],
    failureModes: ['Sharp trend reversals', 'Leverage: gross exposure can exceed 100% when volatility is low'],
    params: {
      lookback: { default: 12, min: 1, max: 24, step: 1, label: 'Lookback k (months)', source: 'MOP headline: k = 12' },
      targetVol: { default: 0.40, min: 0.05, max: 0.60, step: 0.05, label: 'Per-asset volatility target', source: 'MOP: 40%' },
      com: { default: 3, min: 1, max: 24, step: 1, label: 'EWMA center of mass (months)', source: 'Adaptation of MOP’s 60 trading days' },
    },
    warmup: p => Math.max(p.lookback, 24),
    weights: (ctx, p) => {
      const t = ctx.t;
      const delta = p.com / (1 + p.com);
      const w = new Array(ctx.nAssets).fill(0);
      for (let j = 0; j < ctx.nAssets; j++) {
        const r = ctx.assets[j];
        // excess returns r - rf
        let past = 1;
        for (let i = t - p.lookback + 1; i <= t; i++) past *= 1 + (r[i] - ctx.rf[i]);
        const signal = Math.sign(past - 1);
        // EWMA mean and variance over all history through t (weights (1-δ)δ^i, renormalized for finite history)
        // Terms with δ^i < 1e-12 are negligible; truncating them keeps the loop short.
        const iMax = Math.min(t, Math.ceil(Math.log(1e-12) / Math.log(delta)));
        let sw = 0, sm = 0;
        for (let i = 0; i <= iMax; i++) { const wt = (1 - delta) * delta ** i; sw += wt; sm += wt * (r[t - i] - ctx.rf[t - i]); }
        const rbar = sm / sw;
        let sv = 0;
        for (let i = 0; i <= iMax; i++) { const wt = (1 - delta) * delta ** i; sv += wt * ((r[t - i] - ctx.rf[t - i]) - rbar) ** 2; }
        const sigma = Math.sqrt(12 * sv / sw);
        w[j] = sigma > 0 ? (signal * p.targetVol / sigma) / ctx.nAssets : 0;
      }
      return { assets: w };
    },
  },
  {
    id: 'xs-momentum',
    name: 'Cross-sectional momentum',
    family: 'Momentum',
    evidence: 'published-data-restricted',
    summary: 'Each month rank industries by their past J-month return; buy the top 3, short the bottom 3; hold each cohort K months with overlapping portfolios.',
    intuition: 'Recent relative winners have tended to keep outperforming recent losers for several months. Jegadeesh & Titman documented it for stocks; Moskowitz & Grinblatt for industries.',
    equations: [
      { tex: 'R^{(j)}_{t} = \\prod_{i=t-s-J+1}^{t-s} (1 + r^{(j)}_i) - 1', where: 'Formation return over J months, skipping the most recent s months.' },
      { tex: 'w_t = \\frac{1}{K}\\sum_{c=0}^{K-1} w^{\\text{cohort}}_{t-c}, \\quad w^{\\text{cohort}}: +\\tfrac{1}{n}\\ \\text{top } n,\\ -\\tfrac{1}{n}\\ \\text{bottom } n', where: 'Jegadeesh & Titman overlap: each month 1/K of the book is re-formed.' },
    ],
    sources: [
      { key: 'jegadeesh1993winners', where: 'Sec. I and Table I: J, K ∈ {3,6,9,12}; overlapping portfolios' },
      { key: 'moskowitz1999industries', where: 'Industry version: top 3 vs bottom 3 industries (details from secondary sources only; not read in full)' },
      { key: 'carhart1997persistence', where: 'Footnote 3: the 12−2 window (months t−12 to t−2) is available as a preset' },
    ],
    deviations: [
      'Jegadeesh & Titman rank individual NYSE/AMEX stocks into deciles (CRSP, licensed data). Here the ranking is across industry portfolios.',
      'Moskowitz & Grinblatt use 20 industries of their own definition; the French industry set here differs. Their parameters are taken from secondary sources.',
      'Jegadeesh & Titman’s skip variant skips one WEEK (Table I Panel B), which monthly data cannot reproduce. The default here is no skip (their Panel A).',
      'Equal weights within each leg are our choice.',
    ],
    failureModes: ['Momentum crashes after sharp market rebounds (for example 2009)', 'High turnover makes it cost-sensitive'],
    params: {
      J: { default: 6, min: 1, max: 12, step: 1, label: 'Formation J (months)', source: 'JT headline: J = 6' },
      K: { default: 6, min: 1, max: 12, step: 1, label: 'Holding K (months)', source: 'JT headline: K = 6' },
      skip: { default: 0, min: 0, max: 1, step: 1, label: 'Skip s (months)', source: 'JT Panel A: no skip' },
      n: { default: 3, min: 1, max: 5, step: 1, label: 'Industries per leg', source: 'MG: top/bottom 3 (secondary)' },
    },
    presets: [
      { label: 'Jegadeesh–Titman 6/6', values: { J: 6, K: 6, skip: 0 } },
      { label: 'Carhart 12−2 window, 1-month hold', values: { J: 11, K: 1, skip: 1 } },
    ],
    warmup: p => p.J + p.skip + p.K - 1,
    weights: (ctx, p) => cohortAverage(ctx, p, +1),
  },
  {
    id: 'st-reversal',
    name: 'Short-term reversal',
    family: 'Mean reversion',
    evidence: 'published-data-restricted',
    summary: 'Buy last month’s 3 worst industries and short the 3 best; hold one month.',
    intuition: 'Individual stocks have shown 1-month reversal (Jegadeesh 1990; Lehmann 1990 for weekly returns). Secondary sources report that Moskowitz & Grinblatt found the OPPOSITE for industries at 1 month (momentum), so this card is a live test of whether a stock-level effect carries over.',
    equations: [
      { tex: 'w_t: +\\tfrac{1}{n}\\ \\text{on the } n \\text{ lowest } r_t,\\ \\ -\\tfrac{1}{n}\\ \\text{on the } n \\text{ highest } r_t', where: 'One-month formation and holding.' },
    ],
    sources: [
      { key: 'jegadeesh1990predictable', where: 'Monthly reversal in individual stocks' },
      { key: 'lehmann1990fads', where: 'Weekly reversal in individual stocks' },
      { key: 'moskowitz1999industries', where: 'Table 3 (per secondary sources): industries show 1-month momentum, not reversal' },
    ],
    deviations: ['The published reversal evidence is for individual stocks; here it is applied to industry portfolios.'],
    failureModes: ['Very high turnover; the effect is highly cost-sensitive even where it exists'],
    params: {
      n: { default: 3, min: 1, max: 5, step: 1, label: 'Industries per leg', source: 'Matches the momentum card for comparability' },
    },
    warmup: () => 1,
    weights: (ctx, p) => cohortAverage(ctx, { J: 1, K: 1, skip: 0, n: p.n }, -1),
  },
  {
    id: 'ggr-pairs',
    name: 'Pairs trading (distance method)',
    family: 'Relative value',
    evidence: 'published-data-restricted',
    summary: 'Find the industries whose prices moved most alike over the last 12 months; when a pair drifts apart by more than 2 standard deviations, buy the cheaper one and short the dearer one until they meet again.',
    intuition: 'If two assets have tracked each other closely, a gap between them may be temporary. The rule bets that the gap closes. It loses when the gap keeps widening because something real changed.',
    equations: [
      { tex: 'P_j(m) = \\prod_{u=1}^{m} (1 + r_{j,e-F+u}), \\qquad \\text{SSD}(i,j) = \\sum_{m=1}^{F} \\big(P_i(m) - P_j(m)\\big)^2', where: 'Formation: cumulative total-return index of each asset over the F formation months; pairs are matched by the smallest sum of squared deviations.' },
      { tex: '\\text{open when } |Q_a(s) - Q_b(s)| > k\\,\\sigma_{ab}, \\qquad \\text{close when } Q_a - Q_b \\text{ changes sign}', where: 'σ_ab = standard deviation of the formation-period price gap; k = 2. Long the lower-priced leg, short the higher-priced leg, $1 each.' },
      { tex: 'w_t = \\frac{1}{T_r}\\sum_{c=0}^{T_r-1} w^{\\text{cohort}}_{t-c}', where: 'A new set of pairs is formed every month and traded for T_r = 6 months; the overlapping cohorts are averaged.' },
    ],
    sources: [
      { key: 'gatev2006pairs', where: 'Trading rule, formation/trading periods, committed vs employed capital, overlapping portfolios (read in the 1999 NBER working-paper version, w7032)' },
      { key: 'engle1987cointegration', where: 'Background: why prices that move together can drift apart and come back (cointegration)' },
    ],
    deviations: [
      'Gatev et al. trade individual US stocks with DAILY data and check the spread every day. Here the assets are industry portfolios and the spread is checked once a month, so the formation σ comes from 12 monthly points and crossings inside a month are missed.',
      'The paper’s 2σ trigger uses “two historical standard deviations, as estimated during the pairs formation period”; we read that as the sample standard deviation (ddof = 1) of the gap between the two normalized prices. The exact estimator is not stated in the text we read.',
      'Re-normalizing both prices to 1 at the start of the trading period is our choice; the text we read does not say whether the trading-period gap continues the formation index.',
      'Eligible pairs = each asset’s closest partner, ranked by distance (the paper matches “a partner for each stock” and keeps the top pairs). With 12 industries there are at most 11 eligible pairs.',
      'Because the spread is checked only at month-ends and prices are re-normalized at formation end, a cohort cannot open a position in its first month, so each cohort trades for at most T_r − 1 months and about 1/T_r of capital is always idle. With daily checks, as in the paper, this costs only one day.',
      'Returns are on committed capital (the paper’s conservative measure). The engine compounds the whole portfolio monthly; the working-paper text we read does not say exactly how payoffs are compounded within the trading period.',
      'No one-day wait: positions open at the month-end when the trigger fires (the paper reports both versions).',
    ],
    failureModes: ['A pair splits for a real reason (one industry re-rates) and the gap never closes', 'Few eligible pairs in a 12-industry universe; results depend on a handful of trades'],
    params: {
      F: { default: 12, min: 6, max: 36, step: 1, label: 'Formation period F (months)', source: 'GGR: 12 months' },
      Tr: { default: 6, min: 2, max: 12, step: 1, label: 'Trading period (months)', source: 'GGR: 6 months' },
      n: { default: 5, min: 1, max: 10, step: 1, label: 'Pairs per cohort', source: 'GGR: top 5 (also 20)' },
      k: { default: 2, min: 0.5, max: 4, step: 0.25, label: 'Trigger (standard deviations)', source: 'GGR: 2' },
    },
    warmup: p => p.F + p.Tr - 1,
    weights: (ctx, p) => {
      const w = new Array(ctx.nAssets).fill(0);
      for (let c = 0; c < p.Tr; c++) {
        const cw = pairsCohort(ctx, p, ctx.t - c);
        for (let j = 0; j < ctx.nAssets; j++) w[j] += cw[j] / p.Tr;
      }
      return { assets: w };
    },
  },
  {
    id: 'inverse-vol',
    name: 'Inverse-volatility weights (naive risk parity)',
    family: 'Portfolio construction',
    evidence: 'published-data-restricted',
    summary: 'Hold every industry, with weights inversely proportional to its recent volatility, so calmer industries get more money and, when correlations are similar, each contributes a similar amount of risk.',
    intuition: 'Equal money is not equal risk: a volatile industry dominates an equal-weight portfolio’s ups and downs. Scaling each holding by 1/volatility evens out the risk contributions. When all correlations are equal this is exactly the equal-risk-contribution portfolio.',
    equations: [
      { tex: 'w_{j,t} = \\frac{1/\\hat\\sigma_{j,t}}{\\sum_{i=1}^{N} 1/\\hat\\sigma_{i,t}}', where: 'σ̂ = sample standard deviation (ddof = 1) of each asset’s monthly returns over the last M months; fully invested, long only.' },
      { tex: 'w_i\\,\\frac{\\partial \\sigma_p}{\\partial w_i} = w_j\\,\\frac{\\partial \\sigma_p}{\\partial w_j}\\ \\ \\forall i,j', where: 'Equal risk contribution (ERC), the full risk-parity condition. Maillard, Roncalli & Teïletche (2010) show inverse-volatility weights solve it when all pairwise correlations are equal.' },
    ],
    sources: [
      { key: 'maillard2010erc', where: 'Equal risk contribution portfolios; the inverse-volatility special case' },
      { key: 'demiguel2009naive', where: 'Comparison point: 1/N' },
    ],
    deviations: [
      'This is the inverse-volatility shortcut, not a numerical ERC solution that uses the full covariance matrix.',
      'The 36-month window is our choice; the paper does not prescribe an estimation window for this use.',
      'Commercial “risk parity” funds usually lever a balanced stock/bond portfolio; here it is unlevered and stocks only.',
    ],
    failureModes: ['Volatility estimates lag sudden regime changes', 'Calm assets can be calm until they are not (concentration in “safe” sectors)'],
    params: {
      M: { default: 36, min: 12, max: 120, step: 1, label: 'Volatility window M (months)', source: 'Our choice (stated)' },
    },
    warmup: p => p.M,
    weights: (ctx, p) => {
      const inv = ctx.assets.map(r => {
        const xs = r.slice(ctx.t - p.M + 1, ctx.t + 1);
        const m = mean(xs);
        const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (p.M - 1));
        return sd > 0 ? 1 / sd : 0;
      });
      const tot = inv.reduce((a, b) => a + b, 0);
      return { assets: tot > 0 ? inv.map(v => v / tot) : new Array(ctx.nAssets).fill(1 / ctx.nAssets) };
    },
  },
  {
    id: 'mean-variance',
    name: 'Sample mean-variance (Markowitz)',
    family: 'Optimization',
    evidence: 'published-data-restricted',
    summary: 'Estimate mean returns and covariances from the last M months, then hold the tangency portfolio. Textbook-optimal in theory; noisy in practice.',
    intuition: 'Markowitz (1952) is exactly right if you know the true means and covariances. DeMiguel et al. show that plugging in estimates makes it lose to 1/N out of sample unless the history is very long.',
    equations: [
      { tex: 'w_t = \\frac{\\hat\\Sigma_t^{-1}\\hat\\mu_t}{\\mathbf 1^{\\top}\\hat\\Sigma_t^{-1}\\hat\\mu_t}', where: 'μ̂, Σ̂: sample mean and covariance of excess returns over the last M months (DGU 2006 working paper, Sec. 1).' },
    ],
    sources: [
      { key: 'markowitz1952portfolio', where: 'Mean-variance portfolio selection' },
      { key: 'demiguel2009naive', where: 'Sample-based MV rule, M = 60 or 120 (read from the 2006 working-paper version)' },
    ],
    deviations: [
      'Whether the published RFS version divides by the absolute value |1ᵀΣ̂⁻¹μ̂| is unverified; this follows the 2006 working paper, which prints no absolute value. The choice matters when the denominator turns negative: on the development dataset the portfolio is wiped out in 1970-07 with this formula and in 1971-01 with the absolute value. When the denominator is near zero the weights explode: that is a real feature of the method, not a bug, and it shows in the exposure chart.',
      'Weights are unconstrained (shorting and leverage allowed), as in the plug-in rule.',
    ],
    failureModes: ['Estimation error in μ̂ dominates', 'Extreme leverage and turnover'],
    params: {
      M: { default: 120, min: 36, max: 240, step: 12, label: 'Estimation window M (months)', source: 'DGU: M = 60 and 120' },
    },
    warmup: p => p.M,
    weights: (ctx, p) => {
      const t = ctx.t;
      const ex = [];
      for (let j = 0; j < ctx.nAssets; j++) {
        const s = [];
        for (let i = t - p.M + 1; i <= t; i++) s.push(ctx.assets[j][i] - ctx.rf[i]);
        ex.push(s);
      }
      const mu = ex.map(mean);
      const inv = invert(covMatrix(ex));
      if (!inv) return { assets: new Array(ctx.nAssets).fill(1 / ctx.nAssets), note: 'singular covariance; held 1/N' };
      const raw = inv.map(row => row.reduce((s, v, k) => s + v * mu[k], 0));
      const denom = raw.reduce((s, v) => s + v, 0);
      if (Math.abs(denom) < 1e-12) return { assets: new Array(ctx.nAssets).fill(0), note: 'degenerate denominator; held T-bills' };
      return { assets: raw.map(v => v / denom) };
    },
  },
];

function cohortAverage(ctx, p, direction) {
  const w = new Array(ctx.nAssets).fill(0);
  for (let c = 0; c < p.K; c++) {
    const formEnd = ctx.t - c - p.skip;          // last month in the formation window of the cohort formed at t−c
    const formStart = formEnd - p.J + 1;
    const scores = ctx.assets.map(r => cumulative(r, formStart, formEnd));
    const cw = rankLongShort(scores, p.n, direction);
    for (let j = 0; j < ctx.nAssets; j++) w[j] += cw[j] / p.K;
  }
  return { assets: w };
}

/** One distance-method cohort (docs/ENGINE_SPEC.md §6.1): formation ends at row e, decision at ctx.t. */
export function pairsCohort(ctx, p, e) {
  const N = ctx.nAssets, F = p.F, t = ctx.t;
  const w = new Array(N).fill(0);
  if (e - F + 1 < 0) return w;
  const P = ctx.assets.map(r => {
    const out = new Array(F + 1); out[0] = 1;
    for (let m = 1; m <= F; m++) out[m] = out[m - 1] * (1 + r[e - F + m]);
    return out;
  });
  const ssd = (i, j) => { let s = 0; for (let m = 1; m <= F; m++) s += (P[i][m] - P[j][m]) ** 2; return s; };
  const seen = new Set(), eligible = [];
  for (let i = 0; i < N; i++) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < N; j++) { if (j === i) continue; const d = ssd(i, j); if (d < bestD) { bestD = d; best = j; } }
    if (best < 0) continue;
    const a = Math.min(i, best), b = Math.max(i, best), key = a * N + b;
    if (!seen.has(key)) { seen.add(key); eligible.push({ a, b, d: bestD }); }
  }
  eligible.sort((x, y) => (x.d - y.d) || (x.a - y.a) || (x.b - y.b));
  for (const { a, b } of eligible.slice(0, p.n)) {
    const D = []; for (let m = 1; m <= F; m++) D.push(P[a][m] - P[b][m]);
    const mu = D.reduce((s, x) => s + x, 0) / F;
    const sigma = Math.sqrt(D.reduce((s, x) => s + (x - mu) ** 2, 0) / (F - 1));
    if (!(sigma > 0)) continue;
    let qa = 1, qb = 1, open = false, g = 0, qaO = 1, qbO = 1;
    for (let s = e; s <= t; s++) {
      if (s > e) { qa *= 1 + ctx.assets[a][s]; qb *= 1 + ctx.assets[b][s]; }
      const d = qa - qb;
      if (open && (d === 0 || Math.sign(d) !== g)) open = false;
      if (!open && Math.abs(d) > p.k * sigma) { open = true; g = Math.sign(d); qaO = qa; qbO = qb; }
    }
    if (open) {
      const [hi, lo, ghi, glo] = g > 0 ? [a, b, qa / qaO, qb / qbO] : [b, a, qb / qbO, qa / qaO];
      w[hi] -= ghi / p.n;
      w[lo] += glo / p.n;
    }
  }
  return w;
}

export function getStrategy(id) {
  const s = STRATEGIES.find(x => x.id === id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}

export function defaultParams(strategy) {
  return Object.fromEntries(Object.entries(strategy.params).map(([k, v]) => [k, v.default]));
}

export function validateParams(strategy, params) {
  const out = {};
  for (const [k, spec] of Object.entries(strategy.params)) {
    const v = Number(params?.[k] ?? spec.default);
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) throw new Error(`${strategy.name}: ${spec.label} must be between ${spec.min} and ${spec.max}.`);
    out[k] = spec.step >= 1 ? Math.round(v) : v;
  }
  return out;
}
