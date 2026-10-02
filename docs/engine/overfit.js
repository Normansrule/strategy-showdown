// Probability of backtest overfitting (PBO) by combinatorially symmetric cross-validation (CSCV),
// Bailey, Borwein, López de Prado & Zhu (2017). Exact semantics: docs/ENGINE_SPEC.md §8.
//
// Idea: try N configurations on the same months. Split the months into S blocks; for every way of choosing half
// the blocks as "in sample", pick the configuration that looked best in sample and see where it ranks on the other
// half. If the in-sample winner usually lands in the bottom half out of sample, the selection process is
// overfitting. PBO is the share of splits in which that happens.
import { getStrategy, validateParams } from './strategies/index.js';
import { compare } from './runner.js';
import { deflatedSharpe } from './metrics.js';
import { skewness, kurtosisRaw, variance } from './mathx.js';

/** Largest S allowed: C(20, 10) = 184,756 splits; beyond that the enumeration is too slow for a browser. */
export const MAX_S = 20;
const ZERO_SD = 1e-12;
const TIE = 1e-12;

/** All k-subsets of {0..n−1} in lexicographic order. */
export function combinations(n, k) {
  const out = [], cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); rec(i + 1); cur.pop(); }
  })(0);
  return out;
}

export function binomial(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(r);
}

/**
 * CSCV on a T×N matrix given as N column arrays of equal length T.
 * @param {number[][]} columns  columns[n][t] = per-period excess return of trial n at row t
 * @param {{S?: number}} options
 */
export function cscv(columns, { S = 16 } = {}) {
  const N = columns.length;
  if (N < 2) throw new Error('PBO needs at least 2 configurations.');
  if (!Number.isInteger(S) || S < 2 || S % 2 || S > MAX_S) throw new Error(`S must be an even integer from 2 to ${MAX_S}.`);
  const T = columns[0].length;
  if (columns.some(c => c.length !== T)) throw new Error('All configurations must cover the same months.');
  if (columns.some(c => c.some(x => !Number.isFinite(x)))) throw new Error('Every return must be a finite number.');
  const L = Math.floor(T / S);
  if (L < 2) throw new Error(`Too few months (${T}) for S = ${S} blocks.`);
  const drop = T - L * S;
  // Per-block sums of each column CENTRED on its own mean over the used rows (so a constant column gives exactly
  // zero variance and the one-pass formula below does not lose digits); a combination's mean/sd come from summed sums.
  const centre = columns.map(c => { let s = 0; for (let i = drop; i < T; i++) s += c[i]; return s / (T - drop); });
  const sum = columns.map((c, n) => { const b = new Array(S).fill(0); for (let s = 0; s < S; s++) for (let i = 0; i < L; i++) b[s] += c[drop + s * L + i] - centre[n]; return b; });
  const sq = columns.map((c, n) => { const b = new Array(S).fill(0); for (let s = 0; s < S; s++) for (let i = 0; i < L; i++) b[s] += (c[drop + s * L + i] - centre[n]) ** 2; return b; });
  const half = S / 2, nRows = half * L;
  const sharpeOf = (n, blocks) => {
    let s1 = 0, s2 = 0;
    for (const b of blocks) { s1 += sum[n][b]; s2 += sq[n][b]; }
    const mc = s1 / nRows;
    const v = Math.max(0, (s2 - nRows * mc * mc) / (nRows - 1));
    const m = mc + centre[n], sd = Math.sqrt(v);
    return sd > ZERO_SD * Math.max(Math.abs(m), ZERO_SD) ? m / sd : 0; // spec §8: a (numerically) flat column scores 0
  };
  const combos = combinations(S, half);
  const results = [];
  for (const J of combos) {
    const inJ = new Set(J);
    const Jbar = []; for (let b = 0; b < S; b++) if (!inJ.has(b)) Jbar.push(b);
    const R = [], Rb = [];
    for (let n = 0; n < N; n++) { R.push(sharpeOf(n, J)); Rb.push(sharpeOf(n, Jbar)); }
    // Values within TIE (absolute) are equal, so summation-order rounding cannot change the winner or its rank.
    let star = 0;
    for (let n = 1; n < N; n++) if (R[n] > R[star] + TIE) star = n;
    let below = 0, ties = 0;
    for (let j = 0; j < N; j++) { if (j === star) continue; if (Rb[j] < Rb[star] - TIE) below++; else if (Math.abs(Rb[j] - Rb[star]) <= TIE) ties++; }
    const rank = 1 + below + 0.5 * ties;
    const omega = rank / (N + 1);
    results.push({ isBlocks: J, star, isSharpe: R[star], oosSharpe: Rb[star], rank, omega, lambda: Math.log(omega / (1 - omega)) });
  }
  const C = results.length;
  const pbo = results.filter(r => r.lambda <= 0).length / C;
  const probLoss = results.filter(r => r.oosSharpe < 0).length / C;
  const x = results.map(r => r.isSharpe), y = results.map(r => r.oosSharpe);
  const mx = x.reduce((a, b) => a + b, 0) / C, my = y.reduce((a, b) => a + b, 0) / C;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < C; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const degradation = { slope, intercept: my - slope * mx, r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
  const winCount = new Array(N).fill(0); for (const r of results) winCount[r.star]++;
  return { S, T, N, blockLength: L, droppedRows: drop, combinations: C, pbo, probLoss, degradation, results, winCount };
}

/**
 * Run every value of one parameter (or a grid of two) of one strategy on identical conditions and return the
 * trial matrix. All variants share ONE evaluation window, set by the slowest variant.
 * @param {object} ds dataset
 * @param {string} id strategy id
 * @param {object[]} paramSets list of parameter objects (each merged over the defaults)
 * @param {{costs: object, start?: string, end?: string}} options
 */
export function sweep(ds, id, paramSets, options) {
  const strat = getStrategy(id);
  const specs = paramSets.map(p => ({ id, params: validateParams(strat, p) }));
  const res = compare(ds, specs, { costs: options.costs, start: options.start, end: options.end });
  return {
    window: res.window, conditions: res.conditions,
    labels: paramSets.map(p => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ')),
    params: specs.map(s => s.params),
    columns: res.runs.map(r => r.excessNet),
    dates: res.runs[0].dates,
    sharpe: res.runs.map(r => r.metrics.sharpePerPeriod),
  };
}

/** Deflated Sharpe ratio of the best of N trials (Bailey & López de Prado 2014), using every trial's Sharpe. */
export function deflatedBest(columns, sharpes) {
  let best = 0;
  for (let n = 1; n < sharpes.length; n++) if (sharpes[n] > sharpes[best]) best = n;
  const ex = columns[best];
  const N = sharpes.length;
  return { best, N, V: variance(sharpes), ...deflatedSharpe(sharpes[best], ex.length, skewness(ex), kurtosisRaw(ex), variance(sharpes), N) };
}
