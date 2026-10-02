// Probability of backtest overfitting (CSCV, spec §8) and the distance-method pairs strategy (spec §6.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { cscv, combinations, binomial, sweep, deflatedBest } from '../../docs/engine/overfit.js';
import { COST_PRESETS, compare } from '../../docs/engine/runner.js';
import { makeRng } from '../../docs/engine/mathx.js';
import { pairsCohort } from '../../docs/engine/strategies/index.js';
import { FIXTURES, loadJson, assertClose, assertArrayClose } from './helpers.mjs';

const TOL = { rel: 1e-9, abs: 1e-12 };
const gauss = rng => () => { const u = rng.next() || 1e-12, v = rng.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const noise = (seed, N, T, sd = 0.01) => { const z = gauss(makeRng(seed)); return Array.from({ length: N }, () => Array.from({ length: T }, () => sd * z())); };

test('combinations: C(16, 8) = 12,870 in lexicographic order', () => {
  assert.equal(binomial(16, 8), 12870);
  const c = combinations(6, 3);
  assert.equal(c.length, 20);
  assert.deepEqual(c[0], [0, 1, 2]);
  assert.deepEqual(c[19], [3, 4, 5]);
});

test('CSCV by hand: S = 2, two trials, T = 4', () => {
  // Blocks: rows {0,1} and {2,3}. Trial 0 = [1, 3, 0, 2] → block Sharpes 2/√2 = 1.414 and 1/√2 = 0.707;
  // trial 1 = [0, 4, 2, 2] → 2/√8 = 0.707 and sd 0 → Sharpe 0.
  // Combo {0}: IS winner = trial 0 (1.414 > 0.707); OOS trial 0 = 0.707 > trial 1 = 0 → rank 2, ω = 2/3, λ = ln 2 > 0.
  // Combo {1}: IS winner = trial 0 (0.707 > 0); OOS trial 0 = 1.414 > 0.707 → rank 2, λ = ln 2.  PBO = 0.
  const r = cscv([[1, 3, 0, 2], [0, 4, 2, 2]], { S: 2 });
  assert.equal(r.combinations, 2);
  assert.equal(r.pbo, 0);
  for (const c of r.results) { assert.equal(c.star, 0); assert.equal(c.rank, 2); assertClose(c.lambda, Math.log(2), 'λ', TOL); }
});

test('CSCV drops the first T mod S rows (spec §8 step 1)', () => {
  const cols = noise(3, 4, 103);
  const r = cscv(cols, { S: 10 });
  assert.equal(r.droppedRows, 3);
  assert.equal(r.blockLength, 10);
  const r2 = cscv(cols.map(c => c.slice(3)), { S: 10 });
  assert.equal(r.pbo, r2.pbo);
  assertArrayClose(r.results.map(x => x.lambda), r2.results.map(x => x.lambda), 'λ', TOL);
});

test('calibration: with pure-noise trials, PBO averages about 0.5 across datasets', () => {
  const pbos = [];
  for (let seed = 1; seed <= 30; seed++) pbos.push(cscv(noise(seed, 20, 480), { S: 8 }).pbo);
  const m = pbos.reduce((a, b) => a + b, 0) / pbos.length;
  assert.ok(m > 0.38 && m < 0.62, `mean PBO under the null = ${m.toFixed(3)}`);
});

test('power: one trial with a real edge among 49 noise trials gives PBO ≈ 0', () => {
  const cols = noise(5, 50, 800);
  cols[7] = cols[7].map(x => x + 0.01);
  const r = cscv(cols, { S: 16 });
  assert.ok(r.pbo < 0.01, `PBO = ${r.pbo}`);
  assert.ok(r.winCount[7] > 0.99 * r.combinations);
});

test('JS CSCV on JS sweeps == Python reference CSCV on Python sweeps (crosscheck dataset)', () => {
  const ds = loadJson(path.join(FIXTURES, 'crosscheck-dataset.json'));
  const exp = loadJson(path.join(FIXTURES, 'expected-pbo.json'));
  for (const c of exp.cases) {
    const sw = sweep(ds, c.config.id, c.config.params, { costs: COST_PRESETS.realistic });
    assert.equal(sw.columns[0].length, c.T, `${c.config.name}: T`);
    const r = cscv(sw.columns, { S: c.config.S });
    assert.equal(r.combinations, c.combinations, c.config.name);
    assertClose(r.pbo, c.pbo, `${c.config.name} PBO`, TOL);
    assertClose(r.probLoss, c.probLoss, `${c.config.name} prob. of loss`, TOL);
    assertClose(r.degradation.slope, c.slope, `${c.config.name} slope`, TOL);
    assertClose(r.degradation.intercept, c.intercept, `${c.config.name} intercept`, TOL);
    assertClose(r.degradation.r2, c.r2, `${c.config.name} R²`, TOL);
    assertArrayClose(r.results.map(x => x.lambda), c.lambdas, `${c.config.name} λ`, TOL);
  }
});

test('deflatedBest: the best of many noise trials is not significant', () => {
  const cols = noise(9, 40, 600);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const srs = cols.map(c => mean(c) / sd(c));
  const d = deflatedBest(cols, srs);
  assert.equal(d.N, 40);
  assert.ok(d.dsr < 0.95, `DSR of best noise trial = ${d.dsr}`);
});

// ---------- pairs (spec §6.1) ----------
test('pairs cohort: a pair opens only after the gap exceeds kσ, long the laggard and short the leader', () => {
  // Two assets with identical formation paths except tiny noise, then asset 0 jumps +20% in trading month 2.
  const F = 4;
  const a0 = [0.01, 0.02, -0.01, 0.015, 0.0, 0.20, 0.0];
  const a1 = [0.011, 0.019, -0.009, 0.014, 0.0, 0.0, 0.0];
  const a2 = [0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05]; // far from both
  const ctx = t => ({ t, nAssets: 3, assets: [a0, a1, a2].map(a => a.slice(0, t + 1)) });
  const p = { F, Tr: 3, n: 1, k: 2 };
  assert.deepEqual(pairsCohort(ctx(4), p, 3), [0, 0, 0], 'no position before the divergence');
  const w = pairsCohort(ctx(5), p, 3);
  assert.ok(w[0] < 0 && w[1] > 0 && w[2] === 0, `short the leader, long the laggard: ${w}`);
  assertClose(w[0], -1, 'short $1 at opening', TOL);
  assertClose(w[1], 1, 'long $1 at opening', TOL);
});

test('pairs on a planted mean-reverting pair earn a positive Sharpe (naive costs)', () => {
  const rng = makeRng(11), z = gauss(rng), T = 400, N = 6;
  const dates = Array.from({ length: T }, (_, i) => `${1980 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`);
  const assets = Object.fromEntries(Array.from({ length: N }, (_, j) => ['A' + j, []]));
  let x = 0, C = 1, pa0 = 1, pb0 = 1;
  const market = [], rf = [];
  for (let i = 0; i < T; i++) {
    const c = 0.005 + 0.04 * z(); C *= 1 + c; x = 0.3 * x + 0.06 * z();
    const pa = C * Math.exp(x / 2), pb = C * Math.exp(-x / 2);
    assets.A0.push(pa / pa0 - 1); assets.A1.push(pb / pb0 - 1); pa0 = pa; pb0 = pb;
    for (let j = 2; j < N; j++) assets['A' + j].push(0.005 + 0.08 * z());
    market.push(c); rf.push(0.003);
  }
  const ds = { schema: 1, id: 'planted-pair', title: 'Planted pair (synthetic)', frequency: 'monthly', periodsPerYear: 12, synthetic: true, dates, rf, market, assets, factors: null };
  const r = compare(ds, [{ id: 'buy-hold-market', params: {} }, { id: 'ggr-pairs', params: { n: 1 } }], { costs: COST_PRESETS.naive });
  assert.ok(r.runs[1].metrics.sharpe > 0.4, `Sharpe = ${r.runs[1].metrics.sharpe}`);
});

test('a constant column scores Sharpe 0 (spec §8), and bad inputs are refused', () => {
  const cols = noise(21, 5, 160);
  cols.push(new Array(160).fill(0.001));
  const r = cscv(cols, { S: 16 });
  for (const x of r.results) if (x.star === 5) assert.equal(x.isSharpe, 0, 'a flat column that wins does so with Sharpe exactly 0');
  assert.ok(r.results.some(x => x.star !== 5));
  assert.throws(() => cscv([[0.1, NaN, 0.2, 0.1], [0, 0, 0, 0]], { S: 2 }), /finite/);
  assert.throws(() => cscv(noise(1, 3, 400), { S: 22 }), /S must be/);
  assert.throws(() => cscv(noise(1, 3, 400), { S: 7 }), /S must be/);
});
