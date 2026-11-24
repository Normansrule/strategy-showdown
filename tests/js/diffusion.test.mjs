// Information-diffusion diagnostics (docs/research/INFORMATION_DIFFUSION.md §3):
// the JavaScript engine against the independent Python reference, plus known-answer and property tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { momentumBySize, leadLag, DEFAULT_MOM_PERIODS, DEFAULT_LEADLAG_PERIODS, DIFFUSION_CARDS } from '../../docs/engine/diffusion.js';
import { FIXTURES, loadJson, assertClose, assertArrayClose } from './helpers.mjs';

const ds = loadJson(path.join(FIXTURES, 'diffusion-dataset.json'));
const exp = loadJson(path.join(FIXTURES, 'expected-diffusion.json'));
const SUMMARY = ['T', 'mean', 'annMean', 'se', 't', 'lags', 'hitRate'];

test('momentum by size matches the Python reference to 1e-9', () => {
  const js = momentumBySize({ dates: ds.dates, ...ds.series }, { periods: ds.momPeriods });
  assert.equal(js.length, exp.momentumBySize.length);
  js.forEach((r, i) => {
    const e = exp.momentumBySize[i];
    assert.equal(r.id, e.id); assert.equal(r.T, e.T); assert.equal(r.first, e.first); assert.equal(r.last, e.last);
    assert.equal(r.available, e.available);
    if (!e.available) return;
    for (const leg of ['small', 'big', 'gap']) for (const k of SUMMARY) assertClose(r[leg][k], e[leg][k], `${e.id}.${leg}.${k}`);
  });
});

test('lead-lag matches the Python reference to 1e-9', () => {
  const js = leadLag({ dates: ds.dates, ...ds.series }, { periods: ds.leadLagPeriods });
  js.forEach((r, i) => {
    const e = exp.leadLag[i];
    assert.equal(r.id, e.id); assert.equal(r.T, e.T); assert.equal(r.available, e.available);
    if (!e.available) return;
    for (const k of ['corrSmallOnLagBig', 'corrBigOnLagSmall', 'autoSmall', 'autoBig', 'asymmetry', 'corrSE']) assertClose(r[k], e[k], `${e.id}.${k}`);
    for (const reg of ['smallOnLag', 'bigOnLag']) {
      assertArrayClose(r[reg].beta, e[reg].beta, `${e.id}.${reg}.beta`);
      assertArrayClose(r[reg].t, e[reg].t, `${e.id}.${reg}.t`);
      assertClose(r[reg].r2, e[reg].r2, `${e.id}.${reg}.r2`);
      assert.equal(r[reg].lags, e[reg].lags);
    }
  });
});

test('a period shorter than 24 months is reported as unavailable, not computed', () => {
  const r = leadLag({ dates: ds.dates, ...ds.series }, { periods: [{ id: 'x', start: '2010-01' }] })[0];
  assert.equal(r.available, false);
  assert.match(r.reason, /24/);
});

test('identical small and big portfolios give a zero gap in every month', () => {
  const n = 60, dates = Array.from({ length: n }, (_, i) => `${2000 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`);
  const lo = dates.map((_, i) => Math.sin(i) / 50), hi = dates.map((_, i) => Math.cos(i) / 40 + 0.004);
  const r = momentumBySize({ dates, smallLow: lo, smallHigh: hi, bigLow: lo, bigHigh: hi }, { periods: [{ id: 'all' }] })[0];
  assert.equal(r.gap.mean, 0);
  assertClose(r.small.mean, r.big.mean, 'small = big');
});

test('defaults follow the spec: HLS sample 1980–1996, publication February 2000; lead-lag split at 1990', () => {
  assert.deepEqual(DEFAULT_MOM_PERIODS.map(p => [p.id, p.start ?? null, p.end ?? null]), [
    ['full', null, null], ['hls-sample', '1980-01', '1996-12'],
    ['post-sample-pre-publication', '1997-01', '2000-01'], ['post-publication', '2000-02', null]]);
  assert.deepEqual(DEFAULT_LEADLAG_PERIODS.map(p => [p.id, p.start ?? null, p.end ?? null]), [
    ['full', null, null], ['before-1990', null, '1989-12'], ['from-1990', '1990-01', null]]);
});

test('every diffusion card carries an evidence label, sources and the base-rate sentence', () => {
  const LABELS = new Set(['published-replicable', 'published-data-restricted', 'public-description', 'definition']);
  for (const c of DIFFUSION_CARDS) {
    assert.ok(LABELS.has(c.evidence), `${c.id} evidence label`);
    assert.ok(c.sources.length > 0 && c.sources.every(s => /^[a-z0-9_]+$/.test(s.key) && s.level), `${c.id} sources`);
    assert.ok(c.deviations.length > 0, `${c.id} deviations listed`);
    assert.ok(c.notes.includes('History is a base rate, not a forecast.'), `${c.id} base-rate sentence`);
  }
});

test('runs on a dataset assembled by the French loader (format fixtures, 34 months)', async () => {
  const { readFileSync } = await import('node:fs');
  const { loadFrenchFiles } = await import('../../docs/engine/data/loaders.js');
  const names = ['F-F_Research_Data_Factors_CSV.zip', '12_Industry_Portfolios_CSV.zip', 'F-F_Momentum_Factor_CSV.zip', '6_Portfolios_ME_Prior_12_2_CSV.zip'];
  const fr = await loadFrenchFiles(names.map(name => ({ name, bytes: new Uint8Array(readFileSync(path.join(FIXTURES, 'french', name))) })), { now: '2026-09-30T00:00:00.000Z' });
  const input = { dates: fr.dates, ...fr.sizeMomentum.series };
  const m = momentumBySize(input);
  assert.equal(m[0].available, true);
  assert.equal(m[0].T, 34);
  assert.deepEqual(m.slice(1).map(r => r.available), [false, false, true]);
  const l = leadLag(input);
  assert.equal(l[0].T, 33);
});
