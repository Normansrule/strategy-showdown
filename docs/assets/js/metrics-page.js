// Metrics page: intuition → equation → symbols → live worked example (engine functions) → source.
import {
  sharpe, sharpeStdErrIID, loEta, probabilisticSharpe, deflatedSharpe, downsideDeviation, drawdowns, cagr, wealthIndex,
  sharpeDifferenceTest,
} from '../../engine/metrics.js';
import { mean, std, skewness, kurtosisRaw, autocorr, olsNeweyWest, normInv } from '../../engine/mathx.js';
import { $, h, clear, fmt, initPage, loadCitations, citationNode, texNode, renderTex, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom } from './common.js';

initPage();

const DEFAULT_A = '2.1 -1.3 3.4 0.8 -2.6 1.9 4.2 -0.7 1.1 -3.8 2.7 1.5';
const DEFAULT_B = '1.5 -0.9 2.1 1.2 -1.8 1.0 2.9 0.4 0.6 -2.9 1.8 0.9';
let citations = new Map();

function parseSeries(text) {
  const parts = text.replace(/−/g, '-').split(/[\s,;]+/).filter(Boolean);
  const xs = parts.map(Number);
  if (xs.some(x => !Number.isFinite(x))) throw new Error('Only numbers, please.');
  if (xs.some(x => x <= -100 || x > 1000)) throw new Error('Each return must be above −100%.');
  if (xs.length < 6 || xs.length > 24) throw new Error('Use between 6 and 24 numbers.');
  return xs.map(x => x / 100);
}

const pct = (x, d = 2) => fmt(x, 'pct', d);
const n = (x, d = 3) => fmt(x, 'num', d);
const inline = tex => renderTex(h('span', { class: 'tex-inline' }), tex, false);

/** A metric section. spec: {id, title, idea, tex[], symbols[[sym, meaning]], example(a,b)->Node, sources[[key, where]], note?} */
function section(spec, a, b) {
  const eqs = spec.tex.map(t => h('div', { class: 'eq' }, texNode(t)));
  let example;
  try { example = spec.example(a, b); } catch (err) { example = h('p', { class: 'error-box' }, 'Cannot compute for these numbers: ' + err.message); }
  return h('article', { class: 'card', id: spec.id, 'aria-labelledby': spec.id + '-h' },
    h('div', { class: 'card__head' }, h('h2', { id: spec.id + '-h' }, spec.title), spec.chip ? h('span', { class: 'chip chip--level-' + spec.chip.level }, spec.chip.text) : null),
    h('div', { class: 'metric-steps' },
      h('div', {},
        h('h3', {}, 'The idea'), h('div', { class: 'prose' }, spec.idea.map(p => h('p', {}, p))),
        h('h3', {}, 'Equation'), eqs,
        h('h3', {}, 'Symbols'), h('dl', { class: 'symbols' }, spec.symbols.map(([s, m]) => [h('dt', {}, inline(s)), h('dd', {}, m)])),
        spec.note ? h('div', { class: 'callout' }, spec.note.map(p => h('p', { class: 'small' }, p))) : null),
      h('div', {},
        h('h3', {}, 'Worked example (computed live)'), h('div', { class: 'worked' }, example),
        h('h3', {}, 'Source'), spec.sources.length ? spec.sources.map(([k, w]) => citationNode(citations.get(k), w)) : h('p', { class: 'small muted' }, 'A standard definition; no single source.'))));
}

const kv = rows => h('table', { class: 'data' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row', class: 'txt' }, k), h('td', {}, v)))));
const result = (label, value) => h('p', {}, label, ' ', h('span', { class: 'result' }, value));

const SPECS = [
  {
    id: 'cagr', title: 'Compound annual growth rate (CAGR)',
    idea: ['The constant yearly growth rate that would turn $1 into what the strategy actually ended with. Unlike an average of returns, it accounts for compounding: a +50% year followed by a −50% year leaves you with 75 cents, and CAGR says so.'],
    tex: ['W_T = \\prod_{t=1}^{T}(1+r_t), \\qquad \\text{CAGR} = W_T^{\\,q/T} - 1'],
    symbols: [['r_t', 'return in month t (decimal; 0.01 = 1%)'], ['W_T', 'wealth after T months, starting from 1'], ['T', 'number of months'], ['q', 'periods per year: 12 for monthly data']],
    example: a => {
      const W = wealthIndex(a);
      return [kv([['Final wealth W_T', n(W[W.length - 1], 4)], ['Months T', String(a.length)], ['Exponent q/T', n(12 / a.length, 3)]]), result('CAGR =', pct(cagr(a, 12)))];
    },
    sources: [],
  },
  {
    id: 'volatility', title: 'Volatility',
    idea: ['How much monthly excess returns swing around their average, scaled to a year. It measures bumpiness, not loss: a strategy that jumps up a lot is also “volatile”.', 'Excess return means the return minus the T-bill (cash) rate: what the strategy earned for taking risk.'],
    tex: ['\\sigma_{\\text{ann}} = \\sqrt{q}\\;\\sqrt{\\tfrac{1}{T-1}\\sum_{t=1}^{T}(x_t-\\bar x)^2}'],
    symbols: [['x_t', 'excess return in month t'], ['\\bar x', 'average excess return'], ['q', '12 periods per year']],
    example: a => [kv([['Monthly standard deviation', pct(std(a))]]), result('Annualized volatility =', pct(std(a) * Math.sqrt(12)))],
    sources: [],
  },
  {
    id: 'sharpe', title: 'Sharpe ratio and its uncertainty',
    idea: ['Average excess return divided by its volatility: how much reward the strategy earned per unit of risk. Multiplying the monthly ratio by √12 gives the usual annual figure, which is only correct if months are independent.', 'Any Sharpe ratio measured on a finite history is an estimate. Lo (2002) gives its standard error, which the Showdown turns into a 95% range. A range that includes 0 means the data cannot rule out “no reward at all”.'],
    tex: ['\\widehat{SR} = \\frac{\\bar x}{s_x}, \\qquad SR_{\\text{ann}} = \\sqrt{q}\\,\\widehat{SR}', '\\operatorname{SE}(\\widehat{SR}) \\approx \\sqrt{\\frac{1 + \\tfrac12\\widehat{SR}^2}{T}}, \\qquad \\text{95\\% range: } \\sqrt{q}\\,\\big(\\widehat{SR} \\pm 1.96\\,\\operatorname{SE}\\big)'],
    symbols: [['\\bar x', 'mean monthly excess return'], ['s_x', 'sample standard deviation of monthly excess returns'], ['T', 'number of months'], ['1.96', 'the 97.5% point of the normal distribution']],
    example: a => {
      const sr = sharpe(a), se = sharpeStdErrIID(sr, a.length), z = normInv(0.975);
      return [kv([['Mean x̄', pct(mean(a))], ['Std. dev. s', pct(std(a))], ['Monthly Sharpe', n(sr)], ['Standard error (monthly)', n(se)]]),
        result('Annual Sharpe =', n(sr * Math.sqrt(12), 2)),
        h('p', {}, `95% range: [${n((sr - z * se) * Math.sqrt(12), 2)}, ${n((sr + z * se) * Math.sqrt(12), 2)}]. With only ${a.length} months the range is very wide.`)];
    },
    sources: [['sharpe1966mutual', 'Definition of the reward-to-variability ratio'], ['lo2002sharpe', 'Eq. (9): IID standard error']],
  },
  {
    id: 'sharpe-lo', title: 'Autocorrelation-adjusted Sharpe (Lo’s η)',
    idea: ['If good months tend to follow good months (positive autocorrelation), yearly returns are riskier than √12 × monthly risk suggests, and the √12 rule overstates the annual Sharpe ratio. Smoothed or illiquid returns are the usual culprit. Lo’s η(q) replaces √12 with a factor that uses the measured autocorrelations. Negative autocorrelation works the other way.'],
    tex: ['SR_{\\text{ann}} = \\eta(q)\\,\\widehat{SR}, \\qquad \\eta(q) = \\frac{q}{\\sqrt{q + 2\\sum_{k=1}^{q-1}(q-k)\\,\\rho_k}}'],
    symbols: [['\\rho_k', 'sample autocorrelation of monthly excess returns at lag k (both autocovariance and variance divided by T)'], ['q', '12'], ['\\eta(q)', 'equals √12 ≈ 3.46 when all ρ are 0']],
    example: a => {
      const rhos = []; for (let k = 1; k < 12; k++) rhos.push(autocorr(a, k));
      const eta = loEta(12, rhos);
      return [h('p', { class: 'small' }, 'Autocorrelations ρ₁…ρ₁₁:'), h('div', { class: 'pill-row' }, rhos.map((r, i) => h('span', { class: 'pill' }, `ρ${i + 1} ${n(r, 2)}`))),
        kv([['η(12)', n(eta, 3)], ['√12, for comparison', n(Math.sqrt(12), 3)]]), result('Adjusted annual Sharpe =', n(sharpe(a) * eta, 2)),
        h('p', { class: 'small muted' }, 'With 12 data points the autocorrelations are extremely noisy; this is only a demonstration of the arithmetic.')];
    },
    sources: [['lo2002sharpe', 'Eq. (20); Table 4 shows hedge-fund examples overstated by up to 45%']],
  },
  {
    id: 'sortino', title: 'Sortino ratio',
    idea: ['Like the Sharpe ratio, but only the months below a minimum acceptable return (here the T-bill rate) count as risk. Upside surprises are not penalized.'],
    tex: ['\\text{Sortino} = \\sqrt{q}\\,\\frac{\\bar x}{DD}, \\qquad DD = \\sqrt{\\tfrac{1}{T}\\sum_{t=1}^{T}\\min(x_t - \\text{MAR},\\,0)^2}'],
    symbols: [['DD', 'downside deviation: dividing by ALL T months, not just the losing ones'], ['\\text{MAR}', 'minimum acceptable return; the T-bill rate, so MAR = 0 on excess returns']],
    note: ['This follows the “full” definition documented by R PerformanceAnalytics. The original Sortino & Price (1994) text is paywalled and was not read, so its exact definition is unverified here.'],
    chip: { level: 'secondary', text: 'Definition from a secondary source' },
    example: a => {
      const dd = downsideDeviation(a, 0);
      return [kv([['Losing months', String(a.filter(x => x < 0).length) + ' of ' + a.length], ['Downside deviation', pct(dd)]]), result('Sortino =', n(mean(a) / dd * Math.sqrt(12), 2))];
    },
    sources: [['sortino1994downside', 'Original paper (text not verified)']],
  },
  {
    id: 'max-drawdown', title: 'Maximum drawdown',
    idea: ['The worst fall from a previous high point, as a share of that high. It answers the question an investor feels most: “how much could I have been down?” It depends on a single bad stretch, so it is itself a very noisy number.'],
    tex: ['DD_t = \\frac{W_t}{\\max_{s \\le t} W_s} - 1, \\qquad \\text{MaxDD} = \\min_t DD_t'],
    symbols: [['W_t', 'wealth index after month t (starts at 1, and the running peak also starts at 1)']],
    example: a => {
      const d = drawdowns(a);
      return [h('div', { class: 'pill-row' }, d.series.map((v, i) => h('span', { class: 'pill' }, `m${i + 1} ${pct(v, 1)}`))), result('Max drawdown =', pct(d.maxDrawdown, 1)), h('p', {}, `Longest time below a previous peak: ${d.longestUnderwater} months.`)];
    },
    sources: [],
  },
  {
    id: 'turnover', title: 'Turnover',
    idea: ['How much trading a strategy does. Each month, compare the new target weights with the weights the portfolio had drifted to since the last trade, and add up the absolute differences. Turnover is what trading costs are charged on, so it decides how much of a paper result survives costs.'],
    tex: ['\\text{turnover}_t = \\sum_{j} \\left| w_{j,t} - w_{j,t^-} \\right|, \\qquad w_{j,t^-} = \\frac{w_{j,t-1}(1+r_{j,t})}{1 + r^{p}_{t}}', '\\text{annual turnover} = q \\cdot \\overline{\\text{turnover}}'],
    symbols: [['w_{j,t}', 'target weight of asset j decided at the end of month t'], ['w_{j,t^-}', 'weight just before rebalancing, after the month’s price moves'], ['r^{p}_{t}', 'portfolio return that month']],
    example: () => {
      const w0 = [0.5, 0.5], r = [0.10, -0.10];
      const V = 1 + w0[0] * r[0] + w0[1] * r[1];
      const drift = w0.map((w, j) => (w * (1 + r[j])) / V);
      const to = Math.abs(0.5 - drift[0]) + Math.abs(0.5 - drift[1]);
      return [h('p', {}, 'Two assets at 50/50. Asset 1 rises 10%, asset 2 falls 10%. The weights drift to ', h('b', {}, `${pct(drift[0], 1)} / ${pct(drift[1], 1)}`), '. Rebalancing back to 50/50 trades:'), result('turnover =', `${n(to, 3)} (${pct(to, 1)} of the portfolio)`),
        h('p', { class: 'small' }, 'At 10 bps per unit of turnover this rebalance costs ' + fmt(to * 10, 'num', 2) + ' bps of the portfolio.')];
    },
    sources: [['demiguel2009naive', 'Turnover, Eq. (13) of the 2006 working paper']],
  },
  {
    id: 'exposure', title: 'Gross and net exposure',
    idea: ['Gross exposure adds up the size of every position, counting short positions as positive: 1.0 is a fully invested long-only portfolio; 3.0 means positions three times the account, financed by borrowing. Net exposure is longs minus shorts: how much the portfolio moves with the market overall.'],
    tex: ['\\text{gross}_t = \\sum_j |w_{j,t}|, \\qquad \\text{net}_t = \\sum_j w_{j,t}'],
    symbols: [['w_{j,t}', 'weight of asset j (negative = short)']],
    example: () => {
      const w = [0.8, 0.6, -0.4];
      return [h('p', {}, `Weights ${w.map(x => fmt(x, 'num', 1)).join(', ')}:`), kv([['Gross', fmt(w.reduce((s, x) => s + Math.abs(x), 0), 'x', 1)], ['Net', fmt(w.reduce((s, x) => s + x, 0), 'x', 1)]])];
    },
    sources: [],
  },
  {
    id: 'break-even', title: 'Break-even trading cost',
    idea: ['Trading costs are uncertain, so instead of trusting one assumption, ask: at what cost per unit of turnover would this strategy’s average excess return drop to zero? If realistic costs are above this number, the strategy loses money after costs.'],
    tex: ['c^{*} = \\frac{\\overline{x^{\\text{gross}}}}{\\overline{\\text{turnover}}} \\times 10^{4}\\ \\text{bps}'],
    symbols: [['x^{\\text{gross}}', 'monthly excess return before trading costs (after any borrow fee)'], ['\\text{turnover}', 'monthly one-way turnover']],
    example: a => {
      const to = 0.35;
      return [h('p', {}, `Suppose series A is before trading costs and the strategy trades ${pct(to, 0)} of the portfolio each month.`), result('Break-even cost =', fmt(mean(a) / to * 1e4, 'bps', 0))];
    },
    sources: [],
  },
  {
    id: 'psr', title: 'Probabilistic Sharpe ratio (PSR)',
    idea: ['The probability that the true Sharpe ratio is above a threshold (here 0), given how long the record is and how lopsided (skewed) and fat-tailed the returns are. Negative skew and fat tails make a measured Sharpe ratio less trustworthy, and PSR accounts for both.'],
    tex: ['\\text{PSR}(SR^{*}) = \\Phi\\!\\left[\\frac{(\\widehat{SR}-SR^{*})\\sqrt{T-1}}{\\sqrt{1 - \\hat\\gamma_3\\widehat{SR} + \\tfrac{\\hat\\gamma_4-1}{4}\\widehat{SR}^2}}\\right]'],
    symbols: [['\\Phi', 'standard normal cumulative distribution'], ['\\widehat{SR}', 'monthly (not annualized) Sharpe ratio'], ['\\hat\\gamma_3', 'skewness'], ['\\hat\\gamma_4', 'RAW kurtosis (a normal distribution has 3)'], ['SR^{*}', 'threshold; 0 on the Showdown']],
    note: ['Two conventions matter and are pinned by tests: √(T−1) (not √T) and raw kurtosis (not excess). Only raw kurtosis reproduces the paper’s own examples.'],
    example: a => {
      const sr = sharpe(a), sk = skewness(a), ku = kurtosisRaw(a);
      return [kv([['Monthly Sharpe', n(sr)], ['Skewness γ₃', n(sk)], ['Raw kurtosis γ₄', n(ku)], ['T', String(a.length)]]), result('PSR(0) =', n(probabilisticSharpe(sr, 0, a.length, sk, ku), 3))];
    },
    sources: [['bailey2012frontier', 'Eq. (11)']],
  },
  {
    id: 'deflated-sharpe', title: 'Deflated Sharpe ratio (DSR)',
    idea: ['If you try many strategies, the best one will look good by luck. The deflated Sharpe ratio raises the bar from 0 to the Sharpe ratio you would expect from the luckiest of N strategies with no skill at all, then computes PSR against that bar. N is every configuration tried, which is why the Showdown counts your session’s trials.', 'A DSR below 0.95 means the result cannot be distinguished, at the 95% level, from what trying N things would produce by chance.'],
    tex: ['\\widehat{SR}_0 = \\sqrt{V[\\{\\widehat{SR}_n\\}]}\\left((1-\\gamma)\\,\\Phi^{-1}\\!\\left[1-\\tfrac1N\\right] + \\gamma\\,\\Phi^{-1}\\!\\left[1-\\tfrac{1}{Ne}\\right]\\right)', '\\text{DSR} = \\text{PSR}(\\widehat{SR}_0)'],
    symbols: [['N', 'number of configurations tried'], ['V[\\{\\widehat{SR}_n\\}]', 'variance of their Sharpe ratios (same units as SR)'], ['\\gamma', 'Euler–Mascheroni constant ≈ 0.5772'], ['e', 'Euler’s number ≈ 2.718']],
    example: () => {
      const srM = 2.5 / Math.sqrt(250);
      const main = deflatedSharpe(srM, 1250, -3, 10, 0.5 / 250, 100);
      const fewer = deflatedSharpe(srM, 1250, -3, 10, 0.5 / 250, 46);
      return [h('p', {}, 'The paper’s own numerical example: annual Sharpe 2.5 from 5 years of daily returns (T = 1250, 250 days a year), skewness −3, kurtosis 10, N = 100 trials whose annual Sharpe ratios have variance 0.5.'),
        kv([['Daily Sharpe 2.5/√250', n(srM, 4)], ['Expected max of 100 unskilled trials SR₀', n(main.sr0, 4)]]),
        result('DSR =', n(main.dsr, 4)),
        h('p', {}, `The paper reports ≈ 0.9004: below 0.95, so the discovery is rejected. With only N = 46 trials, DSR = ${n(fewer.dsr, 4)} (paper ≈ 0.9505).`)];
    },
    sources: [['bailey2014deflated', 'Eqs. (1)–(2) and the numerical example (numbers via the authors’ companion slides; recomputed here)']],
  },
  {
    id: 'sharpe-difference', title: 'Is one Sharpe ratio really higher? (difference test)',
    idea: ['Two strategies measured over the same months will almost never have exactly equal Sharpe ratios. The question is whether the gap is larger than chance would produce. The test estimates the standard error of the difference and reports a p-value: the probability of a gap at least this large if the true Sharpe ratios were equal.', 'The Showdown writes “not significant” whenever p ≥ 0.05. That does not mean the strategies are equal, only that the data cannot tell them apart.'],
    tex: ['\\Delta = \\frac{\\mu_a}{\\sigma_a} - \\frac{\\mu_b}{\\sigma_b}, \\qquad \\operatorname{SE}(\\hat\\Delta) = \\sqrt{\\nabla^{\\top}\\hat\\Psi\\,\\nabla / T}, \\qquad z = \\hat\\Delta / \\operatorname{SE}', '\\hat\\Psi = \\hat\\Gamma_0 + \\sum_{l=1}^{L}\\left(1-\\tfrac{l}{L+1}\\right)(\\hat\\Gamma_l + \\hat\\Gamma_l^{\\top}), \\qquad L = \\lfloor 4 (T/100)^{2/9} \\rfloor'],
    symbols: [['\\nabla', 'gradient of Δ with respect to the means and second moments of a and b (delta method)'], ['\\hat\\Gamma_l', 'lag-l autocovariance of the moment conditions'], ['L', 'number of lags (Bartlett weights)']],
    note: ['What this is and is not: Ledoit & Wolf (2008) discuss this HAC (heteroskedasticity- and autocorrelation-consistent) approach, but they RECOMMEND a studentized time-series bootstrap instead, especially with fat tails. The bootstrap is on the roadmap. The Bartlett kernel and the lag rule L = ⌊4(T/100)^(2/9)⌋ are our documented choice; the rule is reported by Wooldridge and by Lazarus, Lewis, Stock & Watson (2018), and its attribution to Newey & West (1994) is unverified.'],
    chip: { level: 'unverified', text: 'Not the paper’s recommended method' },
    example: (a, b) => {
      const t = sharpeDifferenceTest(a, b);
      return [kv([['Monthly Sharpe A', n(sharpe(a))], ['Monthly Sharpe B', n(sharpe(b))], ['Difference Δ (population moments)', n(t.delta)], ['Standard error', n(t.se)], ['Lags L', String(t.lags)], ['z', n(t.z, 2)]]),
        result('p-value =', `${fmt(t.pValue, 'p')} → ${t.pValue < 0.05 ? 'significant at 5%' : 'not significant'}`)];
    },
    sources: [['ledoit2008robust', 'Recommends the studentized bootstrap (abstract read; full text not)'], ['newey1987hac', 'Bartlett-weighted HAC covariance']],
  },
  {
    id: 'factor-regression', title: 'Factor regression (what is it really exposed to?)',
    idea: ['Many “new” strategies turn out to be old, well-known exposures in disguise: to the market, to small companies, to cheap “value” stocks, or to momentum. Regressing a strategy’s excess returns on these factors splits them into exposures (betas) and whatever is left over (alpha).', 'A beta of 1.2 on the market means the strategy tends to move 1.2% when the market moves 1%. Alpha is the average monthly return the factors do not explain. Its t-statistic says whether it is distinguishable from zero; standard errors use the Newey–West correction for autocorrelated, uneven-variance residuals.'],
    tex: ['x_t = \\alpha + \\beta_{M}\\,\\text{MktRF}_t + \\beta_{S}\\,\\text{SMB}_t + \\beta_{H}\\,\\text{HML}_t + \\beta_{U}\\,\\text{Mom}_t + \\varepsilon_t'],
    symbols: [['\\text{MktRF}', 'market minus T-bill return'], ['\\text{SMB}', 'small minus big companies'], ['\\text{HML}', 'high minus low book-to-market (value minus growth)'], ['\\text{Mom}', 'recent winners minus recent losers'], ['\\alpha', 'intercept: unexplained average return']],
    example: (a, b) => {
      const fit = olsNeweyWest(a, [b]);
      return [h('p', { class: 'small' }, 'Regressing series A on series B only (as the “market”):'),
        kv([['α (monthly)', `${pct(fit.beta[0])} (t = ${n(fit.t[0], 2)})`], ['β on B', `${n(fit.beta[1], 2)} (t = ${n(fit.t[1], 1)})`], ['R²', n(fit.r2, 2)], ['Newey–West lags', String(fit.lags)]]),
        h('p', {}, fit.r2 > 0.8 ? 'Most of A’s ups and downs are explained by B: A is largely a leveraged version of B.' : 'B explains only part of A.')];
    },
    sources: [['fama1993common', 'Market, SMB and HML factors'], ['carhart1997persistence', 'Adding momentum'], ['newey1987hac', 'HAC standard errors']],
  },
];

// ---------- Kelly illustration ----------
function kellySection() {
  const card = h('article', { class: 'card', id: 'kelly', 'aria-labelledby': 'kelly-h' },
    h('div', { class: 'card__head' }, h('h2', { id: 'kelly-h' }, 'A note on the Kelly criterion'), h('span', { class: 'chip chip--hyp' }, 'Illustration: a coin, not a market')),
    h('div', { class: 'metric-steps' },
      h('div', {},
        h('div', { class: 'prose' },
          h('p', {}, 'Kelly (1956) asked how much of your money to stake on a repeated bet with an edge so that wealth grows fastest in the long run. For an even-money coin that lands heads with probability p, the answer is the fraction f* = 2p − 1.'),
          h('p', {}, 'Why full Kelly is dangerous in practice: the growth curve is flat near the top and falls off a cliff past it. Betting about twice the Kelly fraction gives roughly zero growth (exactly zero in the continuous-time approximation; slightly negative in the coin formula below); betting more shrinks wealth towards zero, even though every bet has a positive expected value. And in markets you never know p: if you overestimate your edge, “full Kelly” is really over-betting. Even at exactly f*, the path is rough: long losing streaks are routine, as the simulation to the right shows. Practitioners who use Kelly usually bet a fraction of it.')),
        h('div', { class: 'eq' }, texNode('g(f) = p\\ln(1+f) + (1-p)\\ln(1-f), \\qquad f^{*} = 2p-1')),
        h('dl', { class: 'symbols' },
          h('dt', {}, inline('g(f)')), h('dd', {}, 'expected log-growth of wealth per bet when staking a fraction f'),
          h('dt', {}, inline('p')), h('dd', {}, 'probability of winning an even-money bet'))),
      h('div', {},
        h('div', { class: 'field' }, h('label', { for: 'kelly-p' }, 'Chance of winning p = ', h('output', { id: 'kelly-p-out', for: 'kelly-p' }, '0.55')),
          h('input', { type: 'range', id: 'kelly-p', min: '0.5', max: '0.7', step: '0.01', value: '0.55' })),
        h('div', { class: 'chart chart--short', id: 'chart-kelly', role: 'img', 'aria-label': 'Growth rate against bet fraction' }),
        h('p', { class: 'fig__caption', id: 'kelly-caption' }),
        h('h3', {}, 'Source'), citationNode(citations.get('kelly1956information'), 'The original information-theoretic argument'))));
  return card;
}
function drawKelly() {
  const p = Number($('#kelly-p').value);
  $('#kelly-p-out').textContent = p.toFixed(2);
  const fStar = 2 * p - 1;
  const xs = []; for (let i = 0; i <= 98; i++) xs.push(i / 100);
  const g = f => p * Math.log(1 + f) + (1 - p) * Math.log(1 - f);
  const data = xs.map(f => [f, g(f) * 100]);
  $('#kelly-caption').textContent = `Kelly fraction f* = ${fmt(fStar * 100, 'num', 0)}% of wealth per bet, growth ${fmt(g(fStar) * 100, 'num', 2)}% per bet. Half Kelly (${fmt(fStar * 50, 'num', 0)}%) keeps ${fmt(g(fStar / 2) / g(fStar) * 100, 'num', 0)}% of that growth with far smaller swings. Growth hits zero near ${fmt(Math.min(0.98, 2 * fStar) * 100, 'num', 0)}% and is negative beyond it.`;
  makeChart($('#chart-kelly'), (t) => ({
    ...chartBase(t),
    grid: { left: 10, right: 16, top: 16, bottom: 22, containLabel: true },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`Bet ${fmt(ps[0].value[0] * 100, 'num', 0)}% of wealth`, [{ name: 'Growth per bet', value: fmt(ps[0].value[1], 'num', 3) + '%', slot: 0 }]) },
    xAxis: { type: 'value', min: 0, max: 0.98, name: 'fraction of wealth bet', nameLocation: 'middle', nameGap: 24, ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, formatter: v => fmt(v * 100, 'num', 0) + '%' } },
    yAxis: { type: 'value', min: v => Math.max(v.min, -Math.max(0.5, v.max * 4)), ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, formatter: v => fmt(v, 'num', 1) + '%' } },
    series: [{
      type: 'line', data, showSymbol: false, lineStyle: { width: 2, color: t.series[0] }, itemStyle: { color: t.series[0] }, emphasis: { disabled: true },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: t.ink3, width: 1, type: 'solid' }, label: { color: t.ink2, fontSize: 11, formatter: d => d.name }, data: [{ xAxis: fStar, name: 'Kelly f*' }, { yAxis: 0, name: '' }] },
      markPoint: { symbol: 'circle', symbolSize: 9, itemStyle: { color: t.series[0], borderColor: t.surface, borderWidth: 2 }, label: { show: false }, data: [{ coord: [fStar, g(fStar) * 100] }] },
    }],
  }));
}

function renderAll() {
  const status = $('#series-status');
  let a, b;
  try {
    a = parseSeries($('#series-a').value);
    b = parseSeries($('#series-b').value);
    if (a.length !== b.length) throw new Error('Series A and B need the same number of months.');
    status.textContent = `${a.length} months each. Mean of A: ${pct(mean(a))} per month.`;
  } catch (err) { status.textContent = err.message; return; }
  const box = clear($('#metric-cards'));
  for (const spec of SPECS) box.appendChild(section(spec, a, b));
  box.appendChild(kellySection());
  $('#kelly-p').addEventListener('input', drawKelly);
  drawKelly();
}

async function main() {
  if (typeof katex === 'undefined' || typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  try { citations = await loadCitations(); } catch { /* references show as missing */ }
  const toc = clear($('#toc'));
  for (const s of SPECS) toc.appendChild(h('li', {}, h('a', { href: '#' + s.id }, s.title.replace(/ \(.*\)$/, ''))));
  toc.appendChild(h('li', {}, h('a', { href: '#kelly' }, 'Kelly criterion')));
  let timer = null;
  const onEdit = () => { clearTimeout(timer); timer = setTimeout(renderAll, 300); };
  $('#series-a').addEventListener('input', onEdit);
  $('#series-b').addEventListener('input', onEdit);
  $('#reset-example').addEventListener('click', () => { $('#series-a').value = DEFAULT_A; $('#series-b').value = DEFAULT_B; renderAll(); });
  renderAll();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
main();
