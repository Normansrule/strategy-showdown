// How markets move: six textbook models of monthly stock returns, fitted to the same data by maximum
// likelihood, simulated, and checked against the "stylized facts" of real returns (Cont 2001).
// Exact definitions: docs/ENGINE_SPEC.md §9.
//
// All models describe monthly LOG returns x_t = ln(1 + r_t).
//   rw      Random walk with normal steps (geometric Brownian motion sampled monthly): x = μ + σz
//           (Bachelier 1900; Osborne 1959; the Black–Scholes 1973 price model)
//   t       Random walk with fat-tailed Student-t steps: x = μ + s·t_ν (Blattberg & Gonedes 1974)
//   jump    Merton (1976) jump-diffusion: x = μ + σz + Σ_{i≤N} J_i,  N ~ Poisson(λ),  J ~ N(μ_J, σ_J²)
//   garch   GARCH(1,1) volatility clustering: x = μ + ε,  ε = σ_t z,  σ_t² = ω + α ε_{t−1}² + β σ_{t−1}² (Bollerslev 1986)
//   gjr     GJR-GARCH: as GARCH but negative surprises add γε² more (Glosten, Jagannathan & Runkle 1993)
//   regime  Two-state Markov regime switching (Hamilton 1989): calm and turbulent states with their own μ, σ
import { mean, std, skewness, kurtosisRaw, autocorr, correlation, makeRng } from './mathx.js';
import { multiStart } from './optimize.js';

const LN2PI = Math.log(2 * Math.PI);
const logistic = v => 1 / (1 + Math.exp(-v));
const logit = p => Math.log(p / (1 - p));

/** ln Γ(x) for x > 0 (Lanczos, g = 7, 9 terms; relative error < 1e-13 for x > 0.5). */
export function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * LN2PI + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// ---------------------------------------------------------------- random variates
function gammaVariate(rng, shape) { // Marsaglia & Tsang (2000); shape < 1 handled by the standard boost
  if (shape < 1) return gammaVariate(rng, shape + 1) * Math.pow(rng.next() || 1e-300, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = rng.normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u || 1e-300) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function poissonVariate(rng, lambda) { // Knuth; fine for the small monthly jump rates used here
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L && k < 1000);
  return k - 1;
}

// ---------------------------------------------------------------- stylized facts
/** Ljung–Box Q statistic over lags 1..m (Ljung & Box 1978). */
export function ljungBox(x, m) {
  const T = x.length;
  let q = 0;
  for (let k = 1; k <= m; k++) q += autocorr(x, k) ** 2 / (T - k);
  return T * (T + 2) * q;
}

/** Max drawdown of the index exp(cumulative log return), as a negative fraction. */
export function maxDrawdownLog(x) {
  let level = 0, peak = 0, mdd = 0;
  for (const v of x) { level += v; if (level > peak) peak = level; mdd = Math.min(mdd, Math.exp(level - peak) - 1); }
  return mdd;
}

export const FACTS = [
  { id: 'volAnn', label: 'Volatility (annualized)', fmt: 'pct', explain: 'Standard deviation of monthly log returns × √12.' },
  { id: 'exKurt', label: 'Fat tails: excess kurtosis', fmt: 'num', explain: '0 for a normal distribution; real returns have more extreme months than a bell curve.', fact: 'Heavy tails' },
  { id: 'tail3', label: 'Months beyond 3 standard deviations', fmt: 'pct2', explain: 'A normal distribution puts 0.27% of months there.', fact: 'Heavy tails' },
  { id: 'skew', label: 'Skewness', fmt: 'num', explain: 'Negative: big falls are more common than equally big rises.', fact: 'Gain/loss asymmetry' },
  { id: 'acf1', label: 'Autocorrelation of returns, lag 1', fmt: 'num', explain: 'Close to 0 means last month’s return says little about this month’s.', fact: 'Absence of autocorrelations' },
  { id: 'absAcf', label: 'Volatility clustering: autocorrelation of |returns|, lags 1–12', fmt: 'num', explain: 'Positive: calm months follow calm months, wild months follow wild months.', fact: 'Volatility clustering' },
  { id: 'leverage', label: 'Leverage effect: corr(return, next |return|)', fmt: 'num', explain: 'Negative: falls tend to be followed by more volatility than rises.', fact: 'Leverage effect' },
  { id: 'kurt12', label: 'Excess kurtosis of 12-month returns', fmt: 'num', explain: 'Closer to 0 than the monthly figure: longer-horizon returns look more normal.', fact: 'Aggregational Gaussianity' },
  { id: 'vr12', label: 'Variance ratio, 12 months', fmt: 'num', explain: '1 for a random walk; above 1 means trends, below 1 means reversals (Lo & MacKinlay 1988).' },
  { id: 'maxDD', label: 'Worst drawdown', fmt: 'pct', explain: 'Largest fall from a previous peak of the cumulative return.' },
];

/** Stylized facts of a series of monthly log returns (definitions in ENGINE_SPEC §9.1). */
export function stylizedFacts(x) {
  const T = x.length, m = mean(x), s = std(x);
  const abs = x.map(Math.abs);
  let absAcf = 0;
  for (let k = 1; k <= 12; k++) absAcf += autocorr(abs, k) / 12;
  const sums12 = [];
  for (let i = 0; i + 12 <= T; i += 12) { let a = 0; for (let j = i; j < i + 12; j++) a += x[j]; sums12.push(a); }
  const over12 = [];
  for (let i = 0; i + 12 <= T; i++) { let a = 0; for (let j = i; j < i + 12; j++) a += x[j]; over12.push(a); }
  let tail = 0;
  for (const v of x) if (Math.abs(v - m) > 3 * s) tail++;
  return {
    meanAnn: 12 * m,
    volAnn: Math.sqrt(12) * s,
    skew: skewness(x),
    exKurt: kurtosisRaw(x) - 3,
    tail3: tail / T,
    acf1: autocorr(x, 1),
    q12: ljungBox(x, 12),
    absAcf,
    leverage: correlation(x.slice(0, -1), abs.slice(1)),
    kurt12: sums12.length > 4 ? kurtosisRaw(sums12) - 3 : NaN,
    vr12: std(over12) ** 2 / (12 * s * s),
    maxDD: maxDrawdownLog(x),
  };
}

// ---------------------------------------------------------------- models: log-likelihood, fit, simulate
const normLogPdf = (x, mu, v) => -0.5 * (LN2PI + Math.log(v) + (x - mu) ** 2 / v);

export const MODELS = {
  rw: {
    name: 'Random walk (normal)',
    tex: 'x_t = \\mu + \\sigma z_t,\\quad z_t \\sim N(0,1)', short: 'Random walk', k: 2,
    cite: ['bachelier1900', 'fama1965behavior', 'black1973pricing'],
    idea: 'Each month’s log return is an independent draw from the same bell curve. The benchmark model of efficient-markets theory and of the Black–Scholes formula.',
    fit(x) {
      const mu = mean(x), sd = std(x, 0); // MLE of σ divides by T
      return { params: { mu, sigma: sd }, ll: x.reduce((a, v) => a + normLogPdf(v, mu, sd * sd), 0) };
    },
    simulate(p, T, rng) { const out = new Array(T); for (let t = 0; t < T; t++) out[t] = p.mu + p.sigma * rng.normal(); return out; },
  },
  t: {
    name: 'Random walk (fat-tailed Student t)',
    tex: 'x_t = \\mu + s\\,\\varepsilon_t,\\quad \\varepsilon_t \\sim t_{\\nu}', short: 'Fat tails (t)', k: 3,
    cite: ['mandelbrot1963variation', 'blattberg1974student'],
    idea: 'Still independent months, but drawn from a Student-t distribution, which allows many more extreme months than a bell curve.',
    ll(x, mu, s, nu) {
      const c = lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI) - Math.log(s);
      let ll = 0;
      for (const v of x) ll += c - (nu + 1) / 2 * Math.log(1 + ((v - mu) / s) ** 2 / nu);
      return ll;
    },
    fit(x) {
      const m0 = mean(x), s0 = std(x);
      const f = th => -this.ll(x, th[0], Math.exp(th[1]), 2 + Math.exp(th[2]));
      const best = multiStart(f, [[m0, Math.log(s0 * 0.8), Math.log(4)], [m0, Math.log(s0), Math.log(10)], [m0, Math.log(s0 * 0.6), Math.log(2)]], { step: [s0 * 0.1, 0.2, 0.5] });
      return { params: { mu: best.x[0], scale: Math.exp(best.x[1]), nu: 2 + Math.exp(best.x[2]) }, ll: -best.f };
    },
    simulate(p, T, rng) {
      const out = new Array(T);
      for (let t = 0; t < T; t++) out[t] = p.mu + p.scale * rng.normal() / Math.sqrt(2 * gammaVariate(rng, p.nu / 2) / p.nu);
      return out;
    },
  },
  jump: {
    name: 'Jump-diffusion (Merton)',
    tex: 'x_t = \\mu + \\sigma z_t + \\sum_{i=1}^{N_t} J_i,\\quad N_t \\sim \\text{Poisson}(\\lambda),\\ J_i \\sim N(\\mu_J, \\sigma_J^2)', short: 'Jumps', k: 5,
    cite: ['merton1976jumps'],
    idea: 'A normal random walk plus occasional sudden jumps (crashes or spikes) that arrive at random, like news shocks.',
    ll(x, mu, sigma, lambda, muJ, sigJ) {
      const K = Math.max(8, Math.ceil(lambda + 8 * Math.sqrt(lambda) + 2));
      const logW = []; for (let k = 0; k <= K; k++) logW.push(-lambda + k * Math.log(lambda) - lgamma(k + 1));
      let ll = 0;
      for (const v of x) {
        let mx = -Infinity; const terms = [];
        for (let k = 0; k <= K; k++) { const tk = logW[k] + normLogPdf(v, mu + k * muJ, sigma * sigma + k * sigJ * sigJ); terms.push(tk); if (tk > mx) mx = tk; }
        let s = 0; for (const tk of terms) s += Math.exp(tk - mx);
        ll += mx + Math.log(s);
      }
      return ll;
    },
    fit(x) {
      const m0 = mean(x), s0 = std(x);
      const f = th => -this.ll(x, th[0], Math.exp(th[1]), Math.exp(th[2]), th[3], Math.exp(th[4]));
      const starts = [
        [m0 + 0.01, Math.log(s0 * 0.8), Math.log(0.1), -0.05, Math.log(s0 * 1.5)],
        [m0, Math.log(s0 * 0.6), Math.log(0.3), -0.02, Math.log(s0)],
        [m0, Math.log(s0 * 0.9), Math.log(0.03), -0.15, Math.log(s0 * 2)],
      ];
      const best = multiStart(f, starts, { step: [s0 * 0.1, 0.2, 0.5, s0 * 0.5, 0.3], maxIter: 3000 });
      const [mu, ls, ll_, muJ, lsJ] = best.x;
      return { params: { mu, sigma: Math.exp(ls), lambda: Math.exp(ll_), muJ, sigmaJ: Math.exp(lsJ) }, ll: -best.f };
    },
    simulate(p, T, rng) {
      const out = new Array(T);
      for (let t = 0; t < T; t++) {
        let v = p.mu + p.sigma * rng.normal();
        const n = poissonVariate(rng, p.lambda);
        for (let i = 0; i < n; i++) v += p.muJ + p.sigmaJ * rng.normal();
        out[t] = v;
      }
      return out;
    },
  },
  garch: {
    name: 'GARCH(1,1) volatility clustering',
    tex: 'x_t = \\mu + \\varepsilon_t,\\ \\varepsilon_t = \\sigma_t z_t,\\quad \\sigma_t^2 = \\omega + \\alpha\\,\\varepsilon_{t-1}^2 + \\beta\\,\\sigma_{t-1}^2', short: 'GARCH', k: 4,
    cite: ['engle1982arch', 'bollerslev1986garch'],
    idea: 'Volatility itself moves: a big surprise this month raises next month’s volatility, which then decays slowly. Calm and stormy periods emerge on their own.',
    unpack(th) {
      const pers = 0.999 * logistic(th[2]);
      const alpha = pers * logistic(th[3]);
      return { mu: th[0], omega: Math.exp(th[1]), alpha, beta: pers - alpha };
    },
    ll(x, p) {
      let h = 0; const m = mean(x); for (const v of x) h += (v - m) ** 2; h /= x.length; // σ₁² = sample variance
      let ll = 0;
      for (let t = 0; t < x.length; t++) {
        if (t > 0) h = p.omega + p.alpha * (x[t - 1] - p.mu) ** 2 + p.beta * h;
        ll += normLogPdf(x[t], p.mu, h);
      }
      return ll;
    },
    fit(x) {
      const m0 = mean(x), v0 = std(x) ** 2;
      const f = th => -this.ll(x, this.unpack(th));
      const start = (pers, a) => { return [m0, Math.log(v0 * (1 - pers)), logit(pers / 0.999), logit(a / pers)]; };
      const best = multiStart(f, [start(0.9, 0.1), start(0.97, 0.05), start(0.6, 0.2)], { step: [Math.sqrt(v0) * 0.1, 0.5, 0.5, 0.5] });
      return { params: this.unpack(best.x), ll: -best.f };
    },
    simulate(p, T, rng) {
      const out = new Array(T);
      let h = p.omega / Math.max(1e-6, 1 - p.alpha - p.beta), eps = 0;
      for (let t = 0; t < T; t++) {
        if (t > 0) h = p.omega + p.alpha * eps * eps + p.beta * h;
        eps = Math.sqrt(h) * rng.normal();
        out[t] = p.mu + eps;
      }
      return out;
    },
  },
  gjr: {
    name: 'GJR-GARCH (asymmetric volatility)',
    tex: '\\sigma_t^2 = \\omega + \\big(\\alpha + \\gamma\\,\\mathbb{1}[\\varepsilon_{t-1}<0]\\big)\\,\\varepsilon_{t-1}^2 + \\beta\\,\\sigma_{t-1}^2', short: 'GJR-GARCH', k: 5,
    cite: ['glosten1993gjr', 'bollerslev1986garch'],
    idea: 'Like GARCH, but a fall raises next month’s volatility more than a rise of the same size: the “leverage effect”.',
    unpack(th) {
      const pers = 0.999 * logistic(th[2]);        // α + γ/2 + β < 1 (covariance stationarity for symmetric shocks)
      const a = pers * logistic(th[3]), rest = pers - a;
      const g = 2 * rest * logistic(th[4]);        // share of the remaining persistence given to γ/2
      return { mu: th[0], omega: Math.exp(th[1]), alpha: a, gamma: g, beta: rest - g / 2 };
    },
    ll(x, p) {
      let h = 0; const m = mean(x); for (const v of x) h += (v - m) ** 2; h /= x.length;
      let ll = 0;
      for (let t = 0; t < x.length; t++) {
        if (t > 0) { const e = x[t - 1] - p.mu; h = p.omega + (p.alpha + (e < 0 ? p.gamma : 0)) * e * e + p.beta * h; }
        ll += normLogPdf(x[t], p.mu, h);
      }
      return ll;
    },
    fit(x) {
      const m0 = mean(x), v0 = std(x) ** 2;
      const f = th => -this.ll(x, this.unpack(th));
      const st = (pers, aShare, gShare) => [m0, Math.log(v0 * (1 - pers)), logit(pers / 0.999), logit(aShare), logit(gShare)];
      const best = multiStart(f, [st(0.9, 0.05, 0.1), st(0.95, 0.03, 0.05), st(0.7, 0.1, 0.3)], { step: [Math.sqrt(v0) * 0.1, 0.5, 0.5, 0.5, 0.5] });
      return { params: this.unpack(best.x), ll: -best.f };
    },
    simulate(p, T, rng) {
      const out = new Array(T);
      let h = p.omega / Math.max(1e-6, 1 - p.alpha - p.gamma / 2 - p.beta), eps = 0;
      for (let t = 0; t < T; t++) {
        if (t > 0) h = p.omega + (p.alpha + (eps < 0 ? p.gamma : 0)) * eps * eps + p.beta * h;
        eps = Math.sqrt(h) * rng.normal();
        out[t] = p.mu + eps;
      }
      return out;
    },
  },
  regime: {
    name: 'Two-regime switching (Hamilton)',
    tex: 'x_t = \\mu_{s_t} + \\sigma_{s_t} z_t,\\quad \\Pr(s_t = j \\mid s_{t-1} = i) = p_{ij},\\ s_t \\in \\{1,2\\}', short: 'Regimes', k: 6,
    cite: ['hamilton1989regime'],
    idea: 'The market flips between a calm regime and a turbulent one, each with its own average return and volatility; regimes tend to persist for a while.',
    unpack(th) {
      const s1 = Math.exp(th[2]), s2 = Math.exp(th[3]);
      return { mu1: th[0], mu2: th[1], sigma1: s1, sigma2: s2, p11: logistic(th[4]), p22: logistic(th[5]) };
    },
    /** Hamilton filter log-likelihood; also returns filtered probabilities of state 2 if wanted. */
    filter(x, p, keep = false) {
      const pi1 = (1 - p.p22) / (2 - p.p11 - p.p22);
      let xi1 = pi1, xi2 = 1 - pi1, ll = 0;
      const prob2 = keep ? [] : null;
      for (const v of x) {
        const pr1 = p.p11 * xi1 + (1 - p.p22) * xi2, pr2 = 1 - pr1;
        const f1 = Math.exp(normLogPdf(v, p.mu1, p.sigma1 ** 2)), f2 = Math.exp(normLogPdf(v, p.mu2, p.sigma2 ** 2));
        const d = pr1 * f1 + pr2 * f2;
        ll += Math.log(d);
        xi1 = pr1 * f1 / d; xi2 = 1 - xi1;
        if (keep) prob2.push(xi2);
      }
      return { ll, prob2 };
    },
    fit(x) {
      const m0 = mean(x), s0 = std(x);
      const f = th => { const p = this.unpack(th); return p.sigma1 > p.sigma2 ? Infinity : -this.filter(x, p).ll; };
      const st = (a, b, c, d, e, g) => [a, b, Math.log(c), Math.log(d), logit(e), logit(g)];
      const best = multiStart(f, [st(m0 + 0.003, m0 - 0.01, s0 * 0.7, s0 * 1.6, 0.97, 0.9), st(m0, m0, s0 * 0.5, s0 * 1.3, 0.95, 0.95), st(m0 + 0.005, m0 - 0.02, s0 * 0.8, s0 * 2.5, 0.98, 0.8)],
        { step: [s0 * 0.1, s0 * 0.2, 0.2, 0.2, 0.5, 0.5], maxIter: 3000 });
      return { params: this.unpack(best.x), ll: -best.f };
    },
    simulate(p, T, rng) {
      const out = new Array(T);
      let state = rng.next() < (1 - p.p22) / (2 - p.p11 - p.p22) ? 1 : 2;
      for (let t = 0; t < T; t++) {
        if (t > 0) state = state === 1 ? (rng.next() < p.p11 ? 1 : 2) : (rng.next() < p.p22 ? 2 : 1);
        out[t] = state === 1 ? p.mu1 + p.sigma1 * rng.normal() : p.mu2 + p.sigma2 * rng.normal();
      }
      return out;
    },
  },
};
export const MODEL_IDS = Object.keys(MODELS);

/** Fit every model to x; AIC = 2k − 2LL, BIC = k ln T − 2LL. */
export function fitAll(x, ids = MODEL_IDS) {
  const T = x.length;
  const out = {};
  for (const id of ids) {
    const m = MODELS[id];
    const { params, ll } = m.fit(x);
    out[id] = { id, params, ll, k: m.k, aic: 2 * m.k - 2 * ll, bic: m.k * Math.log(T) - 2 * ll };
  }
  return out;
}

/**
 * Simulate nSims paths of length T from each fitted model, compute the stylized facts of each path and summarize
 * them as the 5th, 50th and 95th percentiles. A real fact is "reproduced" when it lies inside the 5–95% band.
 */
export function compareFacts(x, fits, { nSims = 200, seed = 1 } = {}) {
  const real = stylizedFacts(x);
  const T = x.length;
  const absX = x.map(Math.abs);
  real.absAcfLags = Array.from({ length: 12 }, (_, i) => autocorr(absX, i + 1));
  const q = (arr, p) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return NaN; const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
  const models = {};
  for (const [id, fit] of Object.entries(fits)) {
    const rng = makeRng(seed + 7919 * MODEL_IDS.indexOf(id));
    const per = {}; for (const f of FACTS) per[f.id] = [];
    let example = null;
    const absAcfLags = new Array(12).fill(0);
    for (let s = 0; s < nSims; s++) {
      const path = MODELS[id].simulate(fit.params, T, rng);
      if (s === 0) example = path;
      const fx = stylizedFacts(path);
      for (const f of FACTS) per[f.id].push(fx[f.id]);
      const ab = path.map(Math.abs);
      for (let k = 1; k <= 12; k++) absAcfLags[k - 1] += autocorr(ab, k) / nSims;
    }
    const bands = {};
    for (const f of FACTS) {
      const lo = q(per[f.id], 0.05), med = q(per[f.id], 0.5), hi = q(per[f.id], 0.95);
      const r = real[f.id];
      bands[f.id] = { lo, med, hi, verdict: !Number.isFinite(r) ? 'n/a' : r < lo ? 'below' : r > hi ? 'above' : 'inside' };
    }
    models[id] = { bands, example, absAcfLags, reproduced: FACTS.filter(f => bands[f.id].verdict === 'inside').length };
  }
  return { real, models, nSims, T };
}
