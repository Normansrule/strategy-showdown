// Pinned published worked examples and hand-computed cases.
// Sources and verification status: /home/claude/research/parameters.md (§7 Lo 2002, §9 Bailey & López de Prado,
// §10 Sortino, §11 Avellaneda & Stoikov). Paper values are printed to 2–4 decimals, so the tolerances below are
// half a unit in the last printed digit unless stated otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deflatedSharpe, expectedMaxSharpe, probabilisticSharpe, minTrackRecordLength, loEta, drawdowns, cagr,
  wealthIndex, downsideDeviation, computeMetrics, sharpeStdErrIID,
} from '../../docs/engine/metrics.js';
import { simulate, PAPER_TABLES, PAPER_SETTINGS, optimalSpread } from '../../docs/engine/sims/avellaneda-stoikov.js';
import { assertClose } from './helpers.mjs';

// ---------- Deflated Sharpe Ratio: Bailey & López de Prado (2014), "A numerical example" ----------
// Daily data, 250 obs/yr. SR 2.5 annualized; V[trial SRs] = 0.5 annualized → de-annualize by /250.
const DAYS = 250;
const srDaily = 2.5 / Math.sqrt(DAYS);
const T_DSR = 1250;
const V_DSR = 0.5 / DAYS;

test('DSR main example: N = 100, skew −3, raw kurtosis 10 → SR0 ≈ 0.1132, DSR ≈ 0.9004', () => {
  const { sr0, dsr } = deflatedSharpe(srDaily, T_DSR, -3, 10, V_DSR, 100);
  assertClose(sr0, 0.1132, 'SR0 (per period)', { rel: 0, abs: 5e-5 });
  assertClose(dsr, 0.9004, 'DSR', { rel: 0, abs: 5e-5 });
  assert.ok(dsr < 0.95, 'the paper rejects the discovery at 95%');
});

test('DSR with fewer trials: N = 46 → ≈ 0.9505', () => {
  assertClose(deflatedSharpe(srDaily, T_DSR, -3, 10, V_DSR, 46).dsr, 0.9505, 'DSR', { rel: 0, abs: 5e-5 });
});

test('DSR normal returns: skew 0, raw kurtosis 3, N = 88 → ≈ 0.9505', () => {
  assertClose(deflatedSharpe(srDaily, T_DSR, 0, 3, V_DSR, 88).dsr, 0.9505, 'DSR', { rel: 0, abs: 5e-5 });
});

test('DSR pins the RAW-kurtosis convention: excess kurtosis (7) would give ≈ 0.9018', () => {
  const wrong = deflatedSharpe(srDaily, T_DSR, -3, 7, V_DSR, 100).dsr;
  assertClose(wrong, 0.9018, 'DSR with excess kurtosis', { rel: 0, abs: 5e-5 });
  assert.ok(Math.abs(wrong - 0.9004) > 1e-3, 'the two conventions are distinguishable at 4 decimals');
});

test('expectedMaxSharpe: undefined trial count gives 0; PSR(SR*) = 0.5 when SR = SR*', () => {
  assert.equal(expectedMaxSharpe(1, 1), 0);
  assertClose(probabilisticSharpe(0.1, 0.1, 100, -1, 6), 0.5, 'PSR at SR*');
});

// ---------- Minimum track record length: Bailey & López de Prado (2012) Eq. 13 ----------
// SR 2 vs benchmark 1 (annualized), 95%, normal (skew 0, raw kurtosis 3). Per-period SR = annual/√m; years = obs/m.
const minTrlYears = (m, skew, kurt) => minTrackRecordLength(2 / Math.sqrt(m), 1 / Math.sqrt(m), skew, kurt, 0.95) / m;
const round2 = x => Math.round(x * 100) / 100;

test('MinTRL daily (252/yr) → 2.73 years', () => {
  // Which periods/yr reproduces 2.73? 250, 252, 260 and 261 all do (2.7312, 2.7310, 2.7302, 2.7301 years), so the
  // printed value cannot tell them apart; 252 (the task's convention) gives 2.7310.
  assert.equal(round2(minTrlYears(252, 0, 3)), 2.73);
  assert.equal(round2(minTrlYears(250, 0, 3)), 2.73);
  assertClose(minTrlYears(252, 0, 3), 2.7310, 'daily', { rel: 0, abs: 1e-4 });
});

test('MinTRL weekly (52) → 2.83, monthly (12) → 3.24', () => {
  assert.equal(round2(minTrlYears(52, 0, 3)), 2.83);
  assert.equal(round2(minTrlYears(12, 0, 3)), 3.24);
});

test('MinTRL monthly, skew −0.72, raw kurtosis 5.78 → 4.99 years', () => {
  assert.equal(round2(minTrlYears(12, -0.72, 5.78)), 4.99);
});

// ---------- Lo (2002) η(q), Eq. 20 ----------
test('Lo η(q): IID gives √q', () => {
  assertClose(loEta(12, new Array(11).fill(0)), Math.sqrt(12), 'η(12) IID', { rel: 1e-15, abs: 0 });
});

test('Lo η(q): q = 12, ρ1 = 0.4, others 0 → 12/√(12 + 2·11·0.4)', () => {
  const rhos = [0.4, ...new Array(10).fill(0)];
  assertClose(loEta(12, rhos), 12 / Math.sqrt(12 + 2 * 11 * 0.4), 'η(12)', { rel: 1e-15, abs: 0 });
  assertClose(loEta(12, rhos), 2.6311740579210876, 'η(12) numeric', { rel: 1e-14, abs: 0 });
});

test('Lo (2002) Eq. 9 IID standard error', () => {
  assertClose(sharpeStdErrIID(0.5, 100), Math.sqrt(1.125 / 100), 'SE');
});

// ---------- Drawdown, CAGR, Sortino on tiny hand-computed series ----------
test('drawdown and CAGR by hand', () => {
  // net = [+10%, −20%, +5%, +10%, −10%]
  // W   = 1.1, 0.88, 0.924, 1.0164, 0.91476 ; running peak 1.1 from month 1
  // DD  = 0, −0.2, −0.16, −0.076, −0.1684  → max drawdown −20%, underwater 4 consecutive months
  const net = [0.10, -0.20, 0.05, 0.10, -0.10];
  const W = wealthIndex(net);
  [1.1, 0.88, 0.924, 1.0164, 0.91476].forEach((v, i) => assertClose(W[i], v, `W[${i}]`, { rel: 1e-14, abs: 0 }));
  const dd = drawdowns(net);
  [0, -0.2, -0.16, -0.076, -0.1684].forEach((v, i) => assertClose(dd.series[i], v, `DD[${i}]`, { rel: 1e-12, abs: 1e-15 }));
  assertClose(dd.maxDrawdown, -0.2, 'maxDrawdown', { rel: 1e-14, abs: 0 });
  assert.equal(dd.longestUnderwater, 4);
  // CAGR with 12 periods/yr over 5 months: 0.91476^(12/5) − 1
  assertClose(cagr(net, 12), Math.pow(0.91476, 12 / 5) - 1, 'cagr', { rel: 1e-13, abs: 0 });
  assertClose(cagr(net, 12), -0.19250991586160027, 'cagr numeric', { rel: 1e-12, abs: 0 });
});

test('drawdown peak is initialised at 1: a first-month loss is a drawdown', () => {
  const dd = drawdowns([-0.1, 0.05]);
  assertClose(dd.maxDrawdown, -0.1, 'maxDD', { rel: 1e-14, abs: 0 });
  assert.equal(dd.longestUnderwater, 2);
});

test('Sortino / downside deviation by hand (MAR = T-bill, divide by all T)', () => {
  // ex = [2%, −1%, 3%, −2%]: mean 0.5%; DD = √((0.01² + 0.02²)/4) = √0.000125 = 0.0111803…
  const ex = [0.02, -0.01, 0.03, -0.02];
  assertClose(downsideDeviation(ex, 0), Math.sqrt(0.000125), 'DD', { rel: 1e-14, abs: 0 });
  const zeros = new Array(4).fill(0);
  const m = computeMetrics({ net: ex, excessNet: ex, grossExcess: ex, turnover: zeros, grossExposure: zeros, netExposure: zeros }, 12);
  assertClose(m.sortino, 0.005 / Math.sqrt(0.000125) * Math.sqrt(12), 'sortino', { rel: 1e-13, abs: 0 });
  assertClose(m.sortino, 1.5491933384829666, 'sortino numeric', { rel: 1e-12, abs: 0 });
  assert.equal(m.hitRate, 0.5);
  assert.equal(m.breakEvenCostBps, Infinity, 'zero turnover → infinite break-even cost');
});

// ---------- Avellaneda & Stoikov (2008) Tables 1–3 ----------
// Fixed seed (1) → deterministic. With seed 1 the worst deviations are: mean profit −1.70 MC s.e. (γ = 1,
// symmetric), std(final q) −7.7% and std(profit) −6.7% (γ = 1, inventory). Seed 2's worst is +14.3% on std(profit)
// (γ = 0.01, symmetric), which is why the dispersion tolerance stays at 15%. See ENGINE_SPEC §7.
test('A&S spread formula reproduces the average spreads 1.49 / 1.35 / 3.02 analytically', () => {
  for (const [gamma, want] of [[0.1, 1.49], [0.01, 1.35], [1, 3.02]]) {
    const p = { ...PAPER_SETTINGS, gamma };
    const n = Math.round(p.T / p.dt);
    let s = 0;
    for (let i = 0; i < n; i++) s += optimalSpread(i * p.dt, p);
    assertClose(s / n, want, `avg spread γ=${gamma}`, { rel: 0, abs: 0.02 });
  }
});

for (const row of PAPER_TABLES) {
  test(`A&S Table γ = ${row.gamma}, ${row.strategy}: simulated statistics match the paper`, () => {
    const sim = simulate({ gamma: row.gamma, strategy: row.strategy, seed: 1 });
    const mcSE = sim.profitStd / Math.sqrt(PAPER_SETTINGS.nSims);
    assert.ok(Math.abs(sim.profitMean - row.profitMean) <= 3 * mcSE,
      `mean profit ${sim.profitMean.toFixed(2)} vs paper ${row.profitMean} (3 MC s.e. = ${(3 * mcSE).toFixed(2)})`);
    assertClose(sim.avgSpread, row.avgSpread, 'average spread', { rel: 0, abs: 0.02 });
    assert.ok(Math.abs(sim.profitStd / row.profitStd - 1) <= 0.15, `std(profit) ${sim.profitStd.toFixed(2)} vs ${row.profitStd}`);
    assert.ok(Math.abs(sim.finalQStd / row.finalQStd - 1) <= 0.15, `std(final q) ${sim.finalQStd.toFixed(2)} vs ${row.finalQStd}`);
  });
}

test('A&S qualitative result: the inventory strategy has lower profit dispersion than symmetric at every γ', () => {
  for (const gamma of [0.1, 0.01, 1]) {
    const inv = simulate({ gamma, strategy: 'inventory', seed: 3 });
    const sym = simulate({ gamma, strategy: 'symmetric', seed: 3 });
    assert.ok(inv.profitStd < sym.profitStd && inv.finalQStd < sym.finalQStd, `γ = ${gamma}`);
  }
});
