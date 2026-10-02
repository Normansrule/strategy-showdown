// Cross-language agreement: the JavaScript engine vs the independent Python reference
// (tests/python/reference.py, written from docs/ENGINE_SPEC.md alone).
//
// Expected values are produced by `python3 tests/python/make_expected.py` and stored in tests/fixtures/.
// Tolerances: every number must agree to relative 1e-9 or absolute 1e-12 (whichever is larger), except where a
// looser tolerance is stated next to the assertion with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { compare, COST_PRESETS, prepareDataset } from '../../docs/engine/runner.js';
import { normCdf, normInv, mean, variance, skewness, kurtosisRaw, autocorr, invert, solve } from '../../docs/engine/mathx.js';
import { FIXTURES, ROOT, loadJson, assertClose, assertArrayClose } from './helpers.mjs';

const METRIC_KEYS = [
  'totalReturn', 'cagr', 'annMeanExcess', 'annVol', 'sharpePerPeriod', 'sharpe', 'sharpeLoAdjusted', 'sortino',
  'maxDrawdown', 'longestUnderwater', 'hitRate', 'skew', 'kurtosis', 'psrVsZero', 'ceq', 'annTurnover',
  'avgGrossExposure', 'avgNetExposure', 'breakEvenCostBps',
];
const SERIES_KEYS = ['net', 'excessNet', 'grossExcess', 'turnover', 'grossExposure', 'netExposure'];

function runEngine(ds, cfg) {
  const options = { costs: COST_PRESETS[cfg.costs], start: cfg.start, end: cfg.end };
  if (cfg.trials) options.trials = cfg.trials;
  return compare(ds, cfg.specs, options);
}

/** Compare one engine comparison against one reference comparison. `tol` may loosen per-quantity tolerances. */
function checkAgainstReference(t, js, exp, tol = {}) {
  const T = tol.default;
  assert.equal(js.dataset.fingerprint, exp.fingerprint, 'dataset fingerprint (SHA-256 of canonical JSON)');
  assert.equal(js.conditions.evalStart, exp.conditions.evalStart, 'evalStart');
  assert.equal(js.conditions.evalEnd, exp.conditions.evalEnd, 'evalEnd');
  assert.equal(js.window.firstEval, exp.window.firstEval, 'firstEval');
  assert.equal(js.window.endIdx, exp.window.endIdx, 'endIdx');
  assert.ok(js.window.bindingWarmup.some(w => w.id === exp.window.binding) || js.window.firstEval > Math.max(...js.window.warmups.map(w => w.months)),
    `binding strategy ${exp.window.binding}`);
  assert.equal(js.runs.length, exp.runs.length);
  js.runs.forEach((run, i) => {
    const e = exp.runs[i];
    const lbl = `${e.id}`;
    assert.equal(run.id, e.id);
    assert.deepEqual(run.dates, e.dates, `${lbl} dates`);
    assert.equal(run.ruinedAt ?? null, e.ruinedAt, `${lbl} ruinedAt`);
    for (const k of SERIES_KEYS) assertArrayClose(run[k], e[k], `${lbl}.${k}`, tol[k] ?? T);
    for (const k of METRIC_KEYS) assertClose(run.metrics[k], e.metrics[k], `${lbl}.metrics.${k}`, tol[k] ?? T);
    assert.equal(run.metrics.periods, e.metrics.T);
    assertArrayClose(run.metrics.sharpeCI, e.metrics.sharpeCI, `${lbl}.sharpeCI`, T);
    if (e.deflatedSharpe === null) assert.equal(run.metrics.deflatedSharpe, null);
    else assertClose(run.metrics.deflatedSharpe, e.deflatedSharpe, `${lbl}.deflatedSharpe`, tol.dsr ?? T);
    const tj = js.tests[i];
    if (e.test === null) assert.equal(tj, null, `${lbl} benchmark has no test`);
    else {
      assertClose(tj.delta, e.test.diff, `${lbl}.test.delta`, T);
      assertClose(tj.se, e.test.se, `${lbl}.test.se`, T);
      assertClose(tj.z, e.test.z, `${lbl}.test.z`, T);
      // p-values are computed as 2(1−Φ(|z|)) in JS vs 2·sf(|z|) in SciPy: for tiny p the subtraction loses digits.
      assertClose(tj.pValue, e.test.p, `${lbl}.test.p`, { rel: 1e-9, abs: 1e-15 });
      assert.equal(tj.lags, e.test.lags);
    }
    const aj = js.attribution[i];
    assertArrayClose(aj.beta, e.attribution.beta, `${lbl}.attribution.beta`, tol.beta ?? T);
    assertArrayClose(aj.se, e.attribution.se, `${lbl}.attribution.se`, tol.beta ?? T);
    assertClose(aj.r2, e.attribution.r2, `${lbl}.attribution.r2`, tol.beta ?? T);
    assert.equal(aj.lags, e.attribution.lags);
  });
  js.corr.forEach((row, i) => assertArrayClose(row, exp.correlation[i], `corr[${i}]`, T));
}

for (const fx of ['crosscheck', 'stress', 'singular']) {
  const ds = loadJson(path.join(FIXTURES, `${fx}-dataset.json`));
  const expected = loadJson(path.join(FIXTURES, `expected-${fx}.json`));
  test(`${fx} fixture is marked synthetic`, () => {
    assert.equal(ds.synthetic, true);
    assert.match(ds.note, /not market data/);
  });
  for (const [name, exp] of Object.entries(expected.runs)) {
    test(`JS engine == Python reference: ${fx} / ${name}`, t => {
      const js = runEngine(ds, exp.config);
      // Same strict tolerance on the stress fixture, even though its mean-variance leverage reaches ~20x.
      const tol = { default: { rel: 1e-9, abs: 1e-12 } };
      checkAgainstReference(t, js, exp, tol);
    });
  }
}

test('singular fixture: mean-variance falls back to 1/N in both implementations', () => {
  const exp = loadJson(path.join(FIXTURES, 'expected-singular.json')).runs['nondefault-realistic'];
  const mv = exp.runs.find(r => r.id === 'mean-variance');
  assert.ok(mv.grossExposure.every(g => Math.abs(g - 1) < 1e-12), 'reference holds 1/N every month');
  const js = runEngine(loadJson(path.join(FIXTURES, 'singular-dataset.json')), exp.config).runs.find(r => r.id === 'mean-variance');
  assert.ok(js.notes.some(n => /singular covariance/.test(n)));
});

test('stress fixture exercises the ruin rule in both implementations', () => {
  const exp = loadJson(path.join(FIXTURES, 'expected-stress.json'));
  const ruined = Object.values(exp.runs).flatMap(r => r.runs.filter(x => x.ruinedAt));
  assert.ok(ruined.length >= 1, 'at least one run is wiped out');
});

// ---------- mathx vs SciPy / NumPy ----------
const mx = loadJson(path.join(FIXTURES, 'mathx-expected.json'));

test('normCdf matches scipy.stats.norm.cdf', () => {
  // Relative 1e-13 on the CDF (and absolute 1e-16 in the far left tail where values are ~1e-17).
  for (const [x, v] of mx.normCdf) assertClose(normCdf(x), v, `normCdf(${x})`, { rel: 1e-13, abs: 1e-16 });
});

test('normInv matches scipy.stats.norm.ppf', () => {
  // Tolerance follows the conditioning of the inverse: dx = dp / φ(x). A CDF error of 4e-16 (a few ulps of p
  // near 1, where double spacing is 1.1e-16) moves x by 4e-16/φ(x), e.g. ~8e-11 at p = 1 − 1e-6. Observed:
  // |diff| 1.05e-11 at p = 0.999999 (upper tail, where p itself carries the rounding); lower tail agrees to 1e-15.
  const phi = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  for (const [p, v] of mx.normInv) {
    assertClose(normInv(p), v, `normInv(${p})`, { rel: 1e-13, abs: 1e-13 + 4e-16 / phi(v) });
    assertClose(normCdf(normInv(p)), p, `normCdf(normInv(${p}))`, { rel: 1e-12, abs: 4e-16 });
  }
  assert.equal(normInv(0), -Infinity);
  assert.equal(normInv(1), Infinity);
});

test('moments and autocorrelation match NumPy/SciPy', () => {
  for (const [name, m] of Object.entries(mx.moments)) {
    assertClose(mean(m.x), m.mean, `${name}.mean`);
    assertClose(variance(m.x), m.variance, `${name}.variance`);
    assertClose(skewness(m.x), m.skewness, `${name}.skewness`, { rel: 1e-10, abs: 1e-12 });
    assertClose(kurtosisRaw(m.x), m.kurtosisRaw, `${name}.kurtosisRaw`, { rel: 1e-10, abs: 1e-12 });
    m.autocorr.forEach((r, k) => assertClose(autocorr(m.x, k + 1), r, `${name}.autocorr(${k + 1})`, { rel: 1e-10, abs: 1e-12 }));
  }
});

test('invert / solve match numpy.linalg', () => {
  for (const { A, b, inv, x } of mx.linalg) {
    const n = A.length;
    const Ai = invert(A);
    for (let i = 0; i < n; i++) assertArrayClose(Ai[i], inv[i], `inv(${n}x${n})[${i}]`, { rel: 1e-11, abs: 1e-13 });
    assertArrayClose(solve(A, b), x, `solve(${n}x${n})`, { rel: 1e-11, abs: 1e-13 });
  }
  assert.equal(invert([[1, 2], [2, 4]]), null, 'singular matrix returns null');
});

// ---------- Optional: the local (gitignored) Kenneth French data copy ----------
const FRENCH = path.join(ROOT, 'docs', 'data', 'local', 'french.json');
test('JS engine == Python reference on local Kenneth French data (optional)', t => {
  if (!existsSync(FRENCH)) {
    t.skip('docs/data/local/french.json not present (gitignored local copy of the French data library); skipped');
    return;
  }
  let python = 'python3';
  const ds = loadJson(FRENCH);
  for (const cfg of ['defaults-realistic', 'nondefault-realistic']) {
    let exp;
    try {
      exp = JSON.parse(execFileSync(python, [path.join(ROOT, 'tests', 'python', 'make_expected.py'), '--dataset', FRENCH, '--config', cfg],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
    } catch (err) {
      t.skip(`python3 with numpy/scipy not available to compute the reference (${err.message.split('\n')[0]}); skipped`);
      return;
    }
    const js = runEngine(ds, exp.config);
    checkAgainstReference(t, js, exp, { default: { rel: 1e-9, abs: 1e-12 } });
  }
});

test('prepareDataset rejects malformed data (spec §1)', () => {
  const ds = loadJson(path.join(FIXTURES, 'crosscheck-dataset.json'));
  const bad = (mutate, re) => { const d = JSON.parse(JSON.stringify(ds)); mutate(d); assert.throws(() => prepareDataset(d), re); };
  bad(d => { d.dates[5] = d.dates[4]; }, /strictly increasing/);
  bad(d => { d.dates[5] = '1990-13'; }, /Bad date/);
  bad(d => { d.rf.pop(); }, /length/);
  bad(d => { d.market[3] = -1; }, /invalid value/);
  bad(d => { d.market[3] = 10.5; }, /invalid value/);
  bad(d => { d.assets.Alpha[3] = NaN; }, /invalid value/);
  bad(d => { d.factors.SMB[3] = Infinity; }, /invalid value/);
  const ok = JSON.parse(JSON.stringify(ds)); ok.market[3] = 10; // upper bound is inclusive
  assert.doesNotThrow(() => prepareDataset(ok));
});
