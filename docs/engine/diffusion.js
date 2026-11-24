// Information-diffusion diagnostics on the French library's 6 size/momentum portfolios.
// Spec: docs/research/INFORMATION_DIFFUSION.md §3. Cross-checked against tests/python/reference.py to 1e-9.
//
// These are DIAGNOSTICS, not strategies: they ask whether the published "slow information" effects show up in
// public portfolio data, and whether they survived publication. Every series is a paper long-short spread,
// gross of trading costs. Nothing here is a recommendation.
import { mean, correlation, olsNeweyWest } from './mathx.js';

export const MIN_PERIOD_MONTHS = 24;

// Hong, Lim & Stein (2000): sample 1980–1996 (NBER Digest, Nov 1998); NBER WP 6553 May 1998; JF Feb 2000.
// The three windows follow McLean & Pontiff (2016): in-sample, out-of-sample before publication, after publication.
export const DEFAULT_MOM_PERIODS = Object.freeze([
  { id: 'full', label: 'Whole sample' },
  { id: 'hls-sample', start: '1980-01', end: '1996-12', label: 'Hong–Lim–Stein sample (1980–1996)' },
  { id: 'post-sample-pre-publication', start: '1997-01', end: '2000-01', label: 'After their sample, before publication' },
  { id: 'post-publication', start: '2000-02', label: 'After publication (Journal of Finance, February 2000)' },
]);

// Lo & MacKinlay published in 1990; the split at January 1990 is OUR choice (their sample end was not checked).
export const DEFAULT_LEADLAG_PERIODS = Object.freeze([
  { id: 'full', label: 'Whole sample' },
  { id: 'before-1990', end: '1989-12', label: 'Before 1990' },
  { id: 'from-1990', start: '1990-01', label: 'From 1990' },
]);

const BASE_RATE = 'History is a base rate, not a forecast.';

export const DIFFUSION_CARDS = Object.freeze([
  {
    id: 'momentum-by-size',
    title: 'Does momentum live where news travels slowly?',
    evidence: 'published-data-restricted',
    claim: 'If news about small, less-followed firms spreads gradually, prices underreact and momentum should be stronger among small stocks (Hong & Stein 1999; Hong, Lim & Stein 2000).',
    sources: [
      { key: 'hong1999unified', where: 'Gradual-information-diffusion model (title and abstract)', level: 'secondary' },
      { key: 'hong2000badnews', where: 'Abstract, NBER Working Paper 6553: momentum profits decline sharply with size, apart from the very smallest stocks', level: 'paper (abstract only)' },
      { key: 'mclean2016academic', where: 'In-sample / out-of-sample / post-publication windows; about 26% and 58% lower returns (CFA Institute digest)', level: 'secondary' },
      { key: 'french_data_library', where: '6 Portfolios Formed on Size and Momentum (2 x 3)', level: 'publisher' },
      { key: 'newey1987hac', where: 'HAC standard errors of each mean', level: 'paper' },
    ],
    deviations: [
      'Hong, Lim & Stein sort individual stocks into size deciles and analyst-coverage groups; we have only two size groups split at the NYSE median, so the very small stocks where the effect is said to be largest are mixed with mid caps.',
      'Analyst coverage, their second proxy, is not in any public dataset we use.',
      'Spreads are value-weighted portfolio returns gross of costs; trading small stocks costs more.',
    ],
    notes: `Winners minus losers = High prior-return portfolio minus Low prior-return portfolio within each size group. Gap = small spread minus big spread. ${BASE_RATE}`,
  },
  {
    id: 'lead-lag-size',
    title: 'Do big stocks lead small stocks?',
    evidence: 'published-data-restricted',
    claim: 'Lo & MacKinlay (1990) study cross-autocovariances between stock portfolios; the widely cited reading is that large stocks lead small stocks, one way slow information shows up in prices (lead direction unverified here).',
    sources: [
      { key: 'lo1990contrarian', where: 'Cross-autocovariances (abstract, NBER Working Paper 2977); the lead direction and weekly design are not confirmed from text read', level: 'unverified' },
      { key: 'french_data_library', where: '6 Portfolios Formed on Size and Momentum (2 x 3)', level: 'publisher' },
      { key: 'newey1987hac', where: 'HAC standard errors of the predictive regressions', level: 'paper' },
    ],
    deviations: [
      'Lo & MacKinlay are widely described as using weekly returns on size portfolios (unverified here); we use monthly returns on two size halves (each the equal average of its three momentum portfolios), which should weaken the effect.',
      'The predictive regressions (small on lagged big and lagged small) are our choice.',
      'The January 1990 split is our choice, at the publication year.',
    ],
    notes: `corrSE = 1/√T is the standard error of a correlation under no dependence; asymmetry > 0 means big leads small. ${BASE_RATE}`,
  },
]);

function periodIndex(dates, start, end) {
  const idx = [];
  dates.forEach((d, i) => { if ((start == null || d >= start) && (end == null || d <= end)) idx.push(i); });
  return idx;
}

function summary(y) {
  const r = olsNeweyWest(y, []);
  return { T: y.length, mean: r.beta[0], annMean: 12 * r.beta[0], se: r.se[0], t: r.t[0], lags: r.lags, hitRate: y.filter(v => v > 0).length / y.length };
}

function checkInput(input, keys) {
  const n = input.dates.length;
  for (const k of keys) {
    if (!Array.isArray(input[k]) || input[k].length !== n) throw new Error(`diffusion: series ${k} must have ${n} values.`);
    if (input[k].some(v => !Number.isFinite(v))) throw new Error(`diffusion: series ${k} has a missing value.`);
  }
}

const short = (p, T) => ({ available: false, reason: `Only ${T} months in ${p.id}; at least ${MIN_PERIOD_MONTHS} are needed.` });

/** Winners-minus-losers within small and within big stocks, and their gap, per period. */
export function momentumBySize(input, { periods = DEFAULT_MOM_PERIODS } = {}) {
  checkInput(input, ['smallLow', 'smallHigh', 'bigLow', 'bigHigh']);
  const { dates } = input;
  const ws = dates.map((_, i) => input.smallHigh[i] - input.smallLow[i]);
  const wb = dates.map((_, i) => input.bigHigh[i] - input.bigLow[i]);
  return periods.map(p => {
    const idx = periodIndex(dates, p.start, p.end);
    const rec = { id: p.id, label: p.label, first: idx.length ? dates[idx[0]] : null, last: idx.length ? dates[idx[idx.length - 1]] : null, T: idx.length };
    if (idx.length < MIN_PERIOD_MONTHS) return { ...rec, ...short(p, idx.length) };
    const s = idx.map(i => ws[i]), b = idx.map(i => wb[i]);
    return { ...rec, available: true, small: summary(s), big: summary(b), gap: summary(s.map((v, j) => v - b[j])) };
  });
}

/** One-month cross-autocorrelations of small- and big-stock returns, and predictive regressions, per period. */
export function leadLag(input, { periods = DEFAULT_LEADLAG_PERIODS } = {}) {
  const keys = ['smallLow', 'smallMid', 'smallHigh', 'bigLow', 'bigMid', 'bigHigh'];
  checkInput(input, keys);
  const { dates } = input;
  const S = dates.map((_, i) => mean(keys.slice(0, 3).map(k => input[k][i])));
  const B = dates.map((_, i) => mean(keys.slice(3).map(k => input[k][i])));
  return periods.map(p => {
    const idx = periodIndex(dates, p.start, p.end);
    const inP = new Set(idx);
    const t1 = idx.slice(1).filter(i => inP.has(i - 1));
    const rec = { id: p.id, label: p.label, first: idx.length ? dates[idx[0]] : null, last: idx.length ? dates[idx[idx.length - 1]] : null, T: t1.length };
    if (t1.length < MIN_PERIOD_MONTHS) return { ...rec, ...short(p, t1.length) };
    const s1 = t1.map(i => S[i]), b1 = t1.map(i => B[i]), s0 = t1.map(i => S[i - 1]), b0 = t1.map(i => B[i - 1]);
    const corrSmallOnLagBig = correlation(s1, b0), corrBigOnLagSmall = correlation(b1, s0);
    const reg = (y, X) => { const r = olsNeweyWest(y, X); return { beta: r.beta, t: r.t, r2: r.r2, lags: r.lags }; };
    return {
      ...rec, available: true,
      corrSmallOnLagBig, corrBigOnLagSmall,
      autoSmall: correlation(s1, s0), autoBig: correlation(b1, b0),
      asymmetry: corrSmallOnLagBig - corrBigOnLagSmall,
      smallOnLag: reg(s1, [b0, s0]),
      bigOnLag: reg(b1, [s0, b0]),
      corrSE: 1 / Math.sqrt(t1.length),
    };
  });
}
