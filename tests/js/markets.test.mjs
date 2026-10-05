// Price models (spec §9), Shiller parser (§10), market-timing simulations (§11) and Almgren–Chriss execution (§12).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nelderMead } from '../../docs/engine/optimize.js';
import { MODELS, stylizedFacts, ljungBox, maxDrawdownLog, lgamma, fitAll, compareFacts } from '../../docs/engine/models.js';
import { parseShillerCsv, shillerToDataset, SHILLER_SOURCE } from '../../docs/engine/data/shiller.js';
import * as T from '../../docs/engine/timing.js';
import { optimalTrajectory, expectedCost, costVariance, linearScheduleClosedForm, frontier } from '../../docs/engine/execution.js';
import { makeRng } from '../../docs/engine/mathx.js';
import { assertClose } from './helpers.mjs';

// ---------- optimizer and special functions ----------
test('Nelder–Mead finds the Rosenbrock minimum (1, 1)', () => {
  const r = nelderMead(([a, b]) => (1 - a) ** 2 + 100 * (b - a * a) ** 2, [-1.2, 1], { step: 0.5, tolF: 1e-14, tolX: 1e-10, maxIter: 20000 });
  assertClose(r.x[0], 1, 'x', { rel: 0, abs: 1e-4 });
  assertClose(r.x[1], 1, 'y', { rel: 0, abs: 1e-4 });
});

test('lgamma matches known values', () => {
  assertClose(lgamma(1), 0, 'Γ(1)', { rel: 0, abs: 1e-13 });
  assertClose(lgamma(5), Math.log(24), 'Γ(5)', { rel: 1e-13, abs: 0 });
  assertClose(lgamma(0.5), Math.log(Math.sqrt(Math.PI)), 'Γ(½)', { rel: 1e-12, abs: 0 });
  assertClose(lgamma(10.3), 13.48203678613836, 'Γ(10.3) vs Python math.lgamma', { rel: 1e-12, abs: 0 });
});

// ---------- stylized facts ----------
test('stylized facts by hand on a tiny series', () => {
  assertClose(maxDrawdownLog([Math.log(1.1), Math.log(0.5), Math.log(1.2)]), -0.5, 'MDD', { rel: 1e-12, abs: 0 });
  const x = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0, -0.03, 0.01];
  // Ljung–Box with m = 1: T(T+2)·ρ1²/(T−1)
  const m = x.reduce((a, b) => a + b) / x.length;
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) den += (x[i] - m) ** 2;
  for (let i = 1; i < x.length; i++) num += (x[i] - m) * (x[i - 1] - m);
  assertClose(ljungBox(x, 1), 8 * 10 * (num / den) ** 2 / 7, 'Q(1)', { rel: 1e-13, abs: 0 });
});

test('a normal random walk shows none of the stylized facts (fact calculators are unbiased enough)', () => {
  const rng = makeRng(1);
  const x = Array.from({ length: 20000 }, () => 0.005 + 0.04 * rng.normal());
  const f = stylizedFacts(x);
  assert.ok(Math.abs(f.exKurt) < 0.15, `excess kurtosis ${f.exKurt}`);
  assert.ok(Math.abs(f.acf1) < 0.03 && Math.abs(f.absAcf) < 0.02 && Math.abs(f.leverage) < 0.03);
  assert.ok(Math.abs(f.vr12 - 1) < 0.1, `VR ${f.vr12}`);
  assert.ok(Math.abs(f.tail3 - 0.0027) < 0.0015);
});

test('averaging prices within the month creates lag-1 autocorrelation of about 0.25 (Working 1960 effect)', () => {
  const rng = makeRng(2);
  let p = 0; const avg = [];
  for (let m = 0; m < 6000; m++) { let s = 0; for (let d = 0; d < 21; d++) { p += 0.01 * rng.normal(); s += p; } avg.push(s / 21); }
  const x = avg.slice(1).map((v, i) => v - avg[i]);
  const f = stylizedFacts(x);
  assert.ok(f.acf1 > 0.2 && f.acf1 < 0.3, `acf1 ${f.acf1}`);
});

// ---------- parameter recovery: each estimator finds the parameters it was simulated with ----------
const recover = (id, truth, T, seed, tol) => {
  const fit = MODELS[id].fit(MODELS[id].simulate(truth, T, makeRng(seed))).params;
  for (const [k, [want, abs]] of Object.entries(tol)) assert.ok(Math.abs(fit[k] - want) <= abs, `${id}.${k}: ${fit[k]} vs ${want} ± ${abs}`);
};
test('recovery: Student t', () => recover('t', { mu: 0.005, scale: 0.03, nu: 5 }, 4000, 5, { mu: [0.005, 0.002], scale: [0.03, 0.003], nu: [5, 1.5] }));
test('recovery: GARCH(1,1)', () => recover('garch', { mu: 0.006, omega: 0.0001, alpha: 0.1, beta: 0.85 }, 4000, 3, { alpha: [0.1, 0.04], beta: [0.85, 0.05] }));
test('recovery: GJR-GARCH', () => recover('gjr', { mu: 0.006, omega: 0.0001, alpha: 0.03, gamma: 0.15, beta: 0.85 }, 6000, 8, { gamma: [0.15, 0.07], beta: [0.85, 0.06] }));
test('recovery: regime switching', () => recover('regime', { mu1: 0.01, mu2: -0.01, sigma1: 0.03, sigma2: 0.08, p11: 0.97, p22: 0.9 }, 4000, 4, { sigma1: [0.03, 0.003], sigma2: [0.08, 0.01], p11: [0.97, 0.015], p22: [0.9, 0.04] }));
test('recovery: Merton jumps', () => recover('jump', { mu: 0.01, sigma: 0.035, lambda: 0.1, muJ: -0.06, sigmaJ: 0.06 }, 6000, 6, { sigma: [0.035, 0.004], lambda: [0.1, 0.05], muJ: [-0.06, 0.03] }));

test('model comparison: on GARCH data, GARCH reproduces volatility clustering and the random walk does not', () => {
  const x = MODELS.garch.simulate({ mu: 0.006, omega: 0.0001, alpha: 0.12, beta: 0.85 }, 1500, makeRng(9));
  const fits = fitAll(x, ['rw', 'garch']);
  assert.ok(fits.garch.aic < fits.rw.aic, 'AIC prefers GARCH');
  const c = compareFacts(x, fits, { nSims: 100, seed: 3 });
  assert.equal(c.models.garch.bands.absAcf.verdict, 'inside');
  assert.equal(c.models.rw.bands.absAcf.verdict, 'above');
});

// ---------- Shiller CSV ----------
const SH_HEAD = 'Date,SP500,Dividend,Earnings,Consumer Price Index,Long Interest Rate,Real Price,Real Dividend,Real Earnings,PE10';
const shillerCsv = (n, tail = 0) => {
  const rows = [SH_HEAD];
  for (let i = 0; i < n + tail; i++) {
    const y = 1900 + Math.floor(i / 12), m = String(i % 12 + 1).padStart(2, '0');
    const real = i < n;
    rows.push([`${y}-${m}-01`, 10 + i * 0.1, real ? 0.6 : 0, real ? 1 : 0, real ? 9 + i * 0.01 : 0, real ? 4 : 0, 0, 0, 0, real && i >= 120 ? 15 : 0].join(','));
  }
  return rows.join('\n') + '\n';
};
test('Shiller parser: total return convention, CAPE zeros → null, FRED-extension rows dropped', () => {
  const sh = parseShillerCsv(shillerCsv(150, 5));
  assert.equal(sh.dates.length, 150);
  assert.equal(sh.dates[0], '1900-01');
  assert.equal(sh.cape[0], null);
  assert.equal(sh.cape[120], 15);
  assertClose(sh.ret[1], (10.1 + 0.6 / 12) / 10 - 1, 'r₁', { rel: 1e-14, abs: 0 });
  assertClose(sh.realRet[1], (1 + sh.ret[1]) * 9 / 9.01 - 1, 'real r₁', { rel: 1e-14, abs: 0 });
  const ds = shillerToDataset(sh);
  assert.equal(ds.market.length, 149);
  assert.ok(ds.rf.every(v => v === 0));
});
test('Shiller parser refuses malformed input', () => {
  assert.throws(() => parseShillerCsv('a,b\n1,2\n'), /Unexpected columns/);
  assert.throws(() => parseShillerCsv(shillerCsv(50)), /10 years/);
  assert.throws(() => parseShillerCsv(shillerCsv(150).replace('1900-03-01', 'x')), /bad date/);
  assert.match(SHILLER_SOURCE.url, new RegExp(SHILLER_SOURCE.commit));
});

// ---------- timing ----------
test('timing: a perfect timer (p = 1) always beats buy-and-hold; p = 0 always loses; p = 0.5 is roughly a coin flip', () => {
  const rng = makeRng(4);
  const ret = Array.from({ length: 600 }, () => 0.007 + 0.045 * rng.normal()), cash = ret.map(() => 0.003);
  assert.equal(T.skillTimers(ret, cash, { p: 1, nSims: 50 }).shareBeatingBuyHold, 1);
  assert.equal(T.skillTimers(ret, cash, { p: 0, nSims: 50 }).shareBeatingBuyHold, 0);
  const coin = T.skillTimers(ret, cash, { p: 0.5, nSims: 400 });
  assert.ok(coin.shareBeatingBuyHold < 0.2, 'a coin-flip timer misses half the equity premium');
  const be = T.breakEvenAccuracy(ret, cash, { nSims: 100 });
  assert.ok(be.breakEven > 0.5 && be.breakEven < 0.8, `break-even ${be.breakEven}`);
});

test('timing rules decide at t for t+1 (no look-ahead) and share one window', () => {
  const rng = makeRng(5);
  const n = 300;
  const ret = [null, ...Array.from({ length: n - 1 }, () => 0.006 + 0.04 * rng.normal())];
  const dates = Array.from({ length: n }, (_, i) => `${1950 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`);
  const series = { dates, ret, cash: ret.map(() => 0.002) };
  const a = T.runTimingRules(series, ['buy-hold', 'sma', 'momentum'], { costBps: 0 });
  const ret2 = ret.slice(); for (let t = 200; t < n; t++) ret2[t] = -0.5; // wreck the future
  const b = T.runTimingRules({ ...series, ret: ret2 }, ['buy-hold', 'sma', 'momentum'], { costBps: 0 });
  assert.equal(a.firstDate, b.firstDate);
  for (const id of ['sma', 'momentum']) {
    const k = 200 - (n - a.months); // index of month 200 within the window
    assert.deepEqual(a.rules[id].positions.slice(0, k + 1), b.rules[id].positions.slice(0, k + 1), `${id} positions up to month 200 unchanged`);
  }
  assert.ok(Object.values(a.rules).every(r => r.returns.length === a.months));
});

test('missing months: missing the best lowers wealth, missing the worst raises it, n = 0 is buy-and-hold', () => {
  const ret = [0.1, -0.2, 0.05, 0.3, -0.1], cash = ret.map(() => 0);
  const m = T.missingMonths(ret, cash, [0, 1]);
  const bh = ret.reduce((w, r) => w * (1 + r), 1);
  assertClose(m[0].missBest, bh, 'n=0', { rel: 1e-14, abs: 0 });
  assertClose(m[1].missBest, bh / 1.3, 'miss best', { rel: 1e-14, abs: 0 });
  assertClose(m[1].missWorst, bh / 0.8, 'miss worst', { rel: 1e-14, abs: 0 });
});

test('lump sum vs DCA by hand: one window, spread over 2 months', () => {
  const r = T.lumpVsDca([0.1, 0.1], [0, 0], { months: 2, spread: 2 });
  // lump: 1.21; DCA: ½ at t0 → ½·1.1·1.1 = 0.605, ½ at t1 → ½·1.1 = 0.55 → 1.155
  assertClose(r.ratios[0], 1.21 / 1.155, 'ratio', { rel: 1e-14, abs: 0 });
});

// ---------- Almgren–Chriss ----------
const AC = { X: 1e6, T: 5, N: 5, sigma: 0.95, eps: 0.0625, eta: 2.5e-6, gamma: 2.5e-7 }; // paper's Table 1
test('Almgren–Chriss: the paper’s example gives κ ≈ 0.6 per day (κT ≈ 3)', () => {
  const tau = AC.T / AC.N, etaT = AC.eta - 0.5 * AC.gamma * tau;
  const kappa = Math.acosh(1 + 1e-6 * AC.sigma ** 2 / etaT * tau * tau / 2) / tau;
  assert.ok(Math.abs(kappa - 0.6) < 0.02, `κ = ${kappa}`);
});
test('Almgren–Chriss: general E and V formulas reproduce the straight-line closed forms (eqs. 10–11)', () => {
  const x = optimalTrajectory({ ...AC, lambda: 0 });
  const cf = linearScheduleClosedForm(AC);
  assertClose(expectedCost(x, { ...AC, tau: 1 }), cf.E, 'E', { rel: 1e-12, abs: 0 });
  assertClose(costVariance(x, { ...AC, tau: 1 }), cf.V, 'V', { rel: 1e-12, abs: 0 });
});
test('Almgren–Chriss: higher risk aversion sells faster, costs more on average and less in variance', () => {
  const f = frontier(AC, [0, 1e-7, 1e-6, 1e-5]);
  for (let i = 1; i < f.length; i++) {
    assert.ok(f[i].x[1] < f[i - 1].x[1], 'front-loaded');
    assert.ok(f[i].E > f[i - 1].E && f[i].V < f[i - 1].V, 'frontier trade-off');
  }
  assert.ok(f.every(p => p.x[0] === AC.X && Math.abs(p.x[AC.N]) < 1e-6));
});

test('best-near-worst baseline: random placement gives the analytic-ish rate and real clustering exceeds it', () => {
  const base = T.bestNearWorstBaseline(800, 20, 6, { nSims: 500 });
  assert.ok(base > 0.1 && base < 0.35, `baseline ${base}`);
  // GARCH data cluster big moves, so the observed share should exceed the baseline
  const x = MODELS.garch.simulate({ mu: 0.006, omega: 0.00005, alpha: 0.15, beta: 0.83 }, 800, makeRng(12)).map(v => Math.exp(v) - 1);
  assert.ok(T.bestNearWorst(x, x.map(() => 0), 20, 6) > base);
});
