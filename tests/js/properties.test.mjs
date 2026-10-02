// Property tests of the engine: no look-ahead, identical conditions, accounting identities, ruin, test size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  compare, commonWindow, prepareDataset, assertComparable, ConditionsMismatchError, COST_PRESETS,
} from '../../docs/engine/runner.js';
import { STRATEGIES, getStrategy, defaultParams } from '../../docs/engine/strategies/index.js';
import { sharpeDifferenceTest } from '../../docs/engine/metrics.js';
import { makeRng, mean } from '../../docs/engine/mathx.js';
import { sha256Hex, canonicalJson } from '../../docs/engine/hash.js';
import { FIXTURES, loadJson, clone, assertClose } from './helpers.mjs';

const BASE = loadJson(path.join(FIXTURES, 'crosscheck-dataset.json'));
const STRESS = loadJson(path.join(FIXTURES, 'stress-dataset.json'));
const ALL_IDS = STRATEGIES.map(s => s.id);

/** Replace every row after t (all series) with different but valid values. */
function perturbAfter(ds, t, seed) {
  const d = clone(ds);
  const rng = makeRng(seed);
  const scramble = arr => { for (let i = t + 1; i < arr.length; i++) arr[i] = Math.max(-0.9, Math.min(5, -2 * arr[i] + 0.05 * rng.normal())); };
  scramble(d.market);
  for (const a of Object.values(d.assets)) scramble(a);
  for (const f of Object.values(d.factors)) scramble(f);
  for (let i = t + 1; i < d.rf.length; i++) d.rf[i] = 0.02 * rng.next();
  return d;
}

// ---------- No look-ahead ----------
for (const id of ALL_IDS) {
  test(`no look-ahead: ${id} weights decided at t are unchanged when rows after t are perturbed`, () => {
    const spec = [{ id, params: {} }];
    const opts = { costs: COST_PRESETS.realistic };
    const base = compare(BASE, spec, opts);
    const first = base.window.firstEval - 1; // first decision month
    const last = base.window.endIdx - 1;
    for (const t of [first, first + 7, Math.floor((first + last) / 2), last - 1]) {
      const pert = compare(perturbAfter(BASE, t, 1000 + t), spec, opts);
      const k = t - first; // run.weights[k] is the decision made at the end of row t
      assert.deepEqual(pert.runs[0].weights[k], base.runs[0].weights[k], `${id}: weights at ${BASE.dates[t]}`);
      assert.deepEqual(pert.runs[0].weights.slice(0, k), base.runs[0].weights.slice(0, k), `${id}: all earlier weights`);
      // ...and the perturbation does change later behaviour for data-dependent strategies (sanity check that it bites).
      if (!['buy-hold-market', 'equal-weight'].includes(id) && k + 2 < base.runs[0].weights.length) {
        assert.notDeepEqual(pert.runs[0].net.slice(k), base.runs[0].net.slice(k));
      }
    }
  });
}

test('no look-ahead at the strategy level: weights() ignores array entries beyond ctx.t even if present', () => {
  // The runner truncates arrays; this checks the strategy code itself does not read past t.
  const ds = prepareDataset(BASE);
  const t = 150;
  const pds = prepareDataset(perturbAfter(BASE, t, 7));
  const ctxOf = d => ({ t, nAssets: d.assetNames.length, assetNames: d.assetNames, market: d.market, rf: d.rf, assets: d.assetNames.map(n => d.assets[n]) });
  for (const s of STRATEGIES) {
    const p = defaultParams(s);
    assert.deepEqual(s.weights(ctxOf(pds), p), s.weights(ctxOf(ds), p), s.id);
  }
});

// ---------- Identical conditions ----------
test('every run carries the spec §3 conditions object and its SHA-256 hash', () => {
  const res = compare(BASE, [{ id: 'buy-hold-market' }, { id: 'tsmom' }], { costs: COST_PRESETS.realistic });
  const keys = ['dataset', 'datasetFingerprint', 'universe', 'universeNote', 'evalStart', 'evalEnd', 'rebalance', 'costs', 'startingPosition'];
  for (const r of res.runs) {
    assert.equal(r.conditions, res.conditions);
    assert.deepEqual(Object.keys(r.conditions).filter(k => k !== 'hash').sort(), [...keys].sort());
    const { hash, ...rest } = r.conditions;
    assert.equal(hash, sha256Hex(canonicalJson(rest)));
  }
  assert.deepEqual(res.conditions.universe, ['Market', ...Object.keys(BASE.assets)]);
});

test('assertComparable throws ConditionsMismatchError naming "costs" when cost models differ', () => {
  const spec = [{ id: 'equal-weight', params: {} }];
  const a = compare(BASE, spec, { costs: COST_PRESETS.naive }).runs[0];
  const b = compare(BASE, spec, { costs: COST_PRESETS.realistic }).runs[0];
  assert.throws(() => assertComparable([a, b]), err => {
    assert.ok(err instanceof ConditionsMismatchError);
    assert.deepEqual(err.differences.map(d => d.key), ['costs']);
    assert.match(err.message, /costs/);
    return true;
  });
  assert.doesNotThrow(() => assertComparable([a, compare(BASE, spec, { costs: COST_PRESETS.naive }).runs[0]]));
});

test('assertComparable names the dataset fields when datasets differ', () => {
  const spec = [{ id: 'equal-weight', params: {} }];
  const other = clone(BASE); other.id = 'synthetic-other'; other.market[200] += 0.001;
  const a = compare(BASE, spec, {}).runs[0];
  const b = compare(other, spec, {}).runs[0];
  assert.throws(() => assertComparable([a, b]), err => {
    assert.ok(err instanceof ConditionsMismatchError);
    const keys = err.differences.map(d => d.key);
    assert.ok(keys.includes('datasetFingerprint') && keys.includes('dataset'), keys.join(','));
    assert.ok(!keys.includes('costs') && !keys.includes('evalStart'), keys.join(','));
    return true;
  });
  // Same id, different contents: the fingerprint alone catches it.
  const sneaky = clone(BASE); sneaky.market[200] += 0.001;
  assert.throws(() => assertComparable([a, compare(sneaky, spec, {}).runs[0]]),
    err => err.differences.length === 1 && err.differences[0].key === 'datasetFingerprint');
});

test('assertComparable names the window when evaluation periods differ', () => {
  const spec = [{ id: 'equal-weight', params: {} }];
  const a = compare(BASE, spec, {}).runs[0];
  const b = compare(BASE, spec, { start: '2000-01' }).runs[0];
  assert.throws(() => assertComparable([a, b]), err => err.differences.map(d => d.key).includes('evalStart'));
});

test('commonWindow starts every strategy at the maximum warm-up and reports the binding strategy', () => {
  const ds = prepareDataset(BASE);
  const specs = [{ id: 'buy-hold-market' }, { id: 'tsmom' }, { id: 'mean-variance', params: { M: 60 } }, { id: 'xs-momentum', params: { J: 12, K: 12, skip: 1 } }];
  // warm-ups: 1, max(12, 24) = 24, 60, 12 + 1 + 12 − 1 = 24
  const w = commonWindow(ds, specs);
  assert.deepEqual(w.warmups.map(x => x.months), [1, 24, 60, 24]);
  assert.equal(w.firstEval, 60);
  assert.deepEqual(w.bindingWarmup.map(x => x.id), ['mean-variance']);
  const res = compare(BASE, specs, {});
  for (const r of res.runs) {
    assert.equal(r.dates[0], BASE.dates[60], `${r.id} starts at the common first month`);
    assert.equal(r.dates.at(-1), BASE.dates.at(-1));
  }
  assert.equal(res.conditions.evalStart, BASE.dates[60]);
  // A requested start later than every warm-up binds instead: no strategy is reported as binding.
  const late = commonWindow(ds, specs, { start: '2000-01' });
  assert.equal(ds.dates[late.firstEval], '2000-01');
  assert.deepEqual(late.bindingWarmup, []);
  // Too short a window is refused.
  assert.throws(() => commonWindow(ds, specs, { start: '2014-06' }), /shorter than 12 months/);
});

// ---------- Accounting identities ----------
const ALL_SPECS = ALL_IDS.map(id => ({ id, params: {} }));
const naive = compare(BASE, ALL_SPECS, { costs: COST_PRESETS.naive });
const real = compare(BASE, ALL_SPECS, { costs: COST_PRESETS.realistic });

test('net(naive) − net(realistic) = turnover·costRate + shortGross·borrowRate every month', () => {
  const costRate = COST_PRESETS.realistic.tradeCostBps / 1e4;
  const borrowRate = COST_PRESETS.realistic.borrowBpsPerYear / 1e4 / 12;
  real.runs.forEach((r, i) => {
    const n = naive.runs[i];
    assert.ok(!r.ruinedAt && !n.ruinedAt, 'no ruin on the base fixture');
    // Weights are stateless functions of the data, so both runs hold identical targets.
    assert.deepEqual(r.weights, n.weights);
    for (let m = 0; m < r.net.length; m++) {
      const shortGross = r.weights[m].reduce((s, w) => s + Math.max(-w, 0), 0);
      const expected = r.turnover[m] * costRate + shortGross * borrowRate;
      assertClose(n.net[m] - r.net[m], expected, `${r.id} month ${r.dates[m]}`, { rel: 1e-9, abs: 1e-15 });
    }
  });
});

test('break-even cost: re-running at tradeCostBps = breakEvenCostBps gives mean excess return ≈ 0', () => {
  for (const r of real.runs) {
    const be = r.metrics.breakEvenCostBps;
    assert.ok(Number.isFinite(be), `${r.id} has turnover`);
    const costs = { mode: 'custom', tradeCostBps: be, borrowBpsPerYear: COST_PRESETS.realistic.borrowBpsPerYear };
    const rerun = compare(BASE, [{ id: r.id, params: {} }], { costs, start: r.dates[0] }).runs[0];
    assert.deepEqual(rerun.dates, r.dates);
    if (rerun.ruinedAt) {
      // The identity mean(excessNet) = mean(grossExcess) − cost·mean(turnover) = 0 breaks only if the cost itself
      // wipes the account out: buy-and-hold trades once (turnover 1.0 in month 1), so its break-even cost is
      // ~14,700 bps and charging it loses > 100% on day one. Check that this is the reason, then move on.
      assert.equal(r.id, 'buy-hold-market');
      assert.ok(rerun.turnover[0] * be / 1e4 >= 1, 'first-month cost alone exceeds 100%');
      continue;
    }
    assert.ok(Math.abs(mean(rerun.excessNet)) < 1e-15, `${r.id}: mean excessNet ${mean(rerun.excessNet)} at ${be.toFixed(2)} bps`);
    assertClose(mean(rerun.excessNet), 0, `${r.id} break-even`, { rel: 0, abs: 1e-15 });
  }
});

test('turnover: buy-and-hold trades 1.0 in its first month (from T-bills) and only drift afterwards is zero', () => {
  const bh = real.runs.find(r => r.id === 'buy-hold-market');
  assertClose(bh.turnover[0], 1, 'initial purchase', { rel: 0, abs: 1e-15 });
  // Market weight 1 drifts to (1 + r)/(1 + r) = 1: no rebalancing trades after the first month.
  for (let m = 1; m < bh.turnover.length; m++) assert.ok(bh.turnover[m] < 1e-15, `month ${m}`);
});

// ---------- Ruin rule ----------
test('ruin: a run that loses ≥ 100% records ruinedAt, books −100% once, and is flat afterwards', () => {
  const res = compare(STRESS, [{ id: 'buy-hold-market' }, { id: 'mean-variance' }], { costs: COST_PRESETS.realistic });
  const mv = res.runs[1];
  assert.ok(mv.ruinedAt, 'the stress fixture wipes out mean-variance');
  const k = mv.dates.indexOf(mv.ruinedAt);
  assert.equal(mv.net[k], -1);
  assert.equal(mv.excessNet[k], -1 - STRESS.rf[STRESS.dates.indexOf(mv.ruinedAt)]);
  for (let m = k + 1; m < mv.net.length; m++) {
    const rf = STRESS.rf[STRESS.dates.indexOf(mv.dates[m])];
    assert.equal(mv.net[m], 0);
    assert.equal(mv.excessNet[m], -rf);
    assert.equal(mv.grossExcess[m], -rf);
    assert.equal(mv.turnover[m], 0);
    assert.equal(mv.grossExposure[m], 0);
    assert.equal(mv.netExposure[m], 0);
    assert.ok(mv.weights[m].every(w => w === 0));
  }
  assert.equal(mv.metrics.totalReturn, -1);
  assert.equal(mv.metrics.maxDrawdown, -1);
  assert.equal(mv.metrics.cagr, -1);
  assert.ok(mv.notes.some(n => /wiped out/.test(n)));
});

test('ruin: a hand-built dataset where a 2x-levered position loses 60% in one month', () => {
  // tsmom sizes by target/σ: with calm history σ is small, so leverage is large; then the asset falls 60%.
  const T = 40;
  const dates = Array.from({ length: T }, (_, i) => `${2000 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`);
  const calm = i => 0.01 + 0.002 * ((i % 2) ? 1 : -1);
  const a = Array.from({ length: T }, (_, i) => (i === 30 ? -0.6 : calm(i)));
  const ds = {
    id: 'hand-ruin', synthetic: true, dates, rf: new Array(T).fill(0.001), market: a.slice(),
    assets: { A: a.slice(), B: a.slice() },
  };
  const run = compare(ds, [{ id: 'tsmom' }], { costs: COST_PRESETS.naive }).runs[0];
  assert.equal(run.ruinedAt, dates[30]);
  const k = run.dates.indexOf(dates[30]);
  assert.ok(run.grossExposure[k] > 1 / 0.6, 'levered enough to lose everything');
  assert.equal(run.net[k], -1);
  assert.ok(run.net.slice(k + 1).every(x => x === 0));
});

// ---------- Size of the Sharpe-difference test ----------
test('Sharpe-difference test has roughly correct size under H0 (2% ≤ rejection rate at 5% ≤ 9%)', () => {
  const rng = makeRng(20260930);
  const T = 240, reps = 1000;
  let rejections = 0;
  for (let r = 0; r < reps; r++) {
    // Equal true Sharpe ratios (0.125 per month) with different scales, independent iid normal.
    const a = Array.from({ length: T }, () => 0.005 + 0.04 * rng.normal());
    const b = Array.from({ length: T }, () => 0.01 + 0.08 * rng.normal());
    if (sharpeDifferenceTest(a, b).pValue < 0.05) rejections++;
  }
  const rate = rejections / reps;
  assert.ok(rate >= 0.02 && rate <= 0.09, `rejection rate ${rate}`);
});

test('Sharpe-difference test rejects a large true difference (power sanity check)', () => {
  const rng = makeRng(99);
  const T = 240;
  const a = Array.from({ length: T }, () => 0.02 + 0.04 * rng.normal()); // SR 0.5/month
  const b = Array.from({ length: T }, () => -0.004 + 0.04 * rng.normal());
  assert.ok(sharpeDifferenceTest(a, b).pValue < 0.01);
});
