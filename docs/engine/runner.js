// The comparison runner. Its one job: make sure every algorithm is judged under IDENTICAL conditions
// (same data snapshot, universe, evaluation window, cost model, rebalance calendar) and refuse otherwise.
import { getStrategy, validateParams } from './strategies/index.js';
import { computeMetrics, sharpeDifferenceTest, expectedMaxSharpe, probabilisticSharpe } from './metrics.js';
import { correlation, olsNeweyWest, variance, skewness, kurtosisRaw } from './mathx.js';
import { sha256Hex, canonicalJson } from './hash.js';

export const COST_PRESETS = {
  naive: { mode: 'naive', tradeCostBps: 0, borrowBpsPerYear: 0 },
  // ASSUMPTIONS, not measurements: adjustable in the UI; every run also reports its break-even cost.
  realistic: { mode: 'realistic', tradeCostBps: 10, borrowBpsPerYear: 50 },
};

export class ConditionsMismatchError extends Error {
  constructor(differences) {
    super('Runs were not produced under identical conditions: ' + differences.map(d => d.key).join(', '));
    this.differences = differences;
  }
}

/** Validate a dataset object and attach a content fingerprint. Throws on malformed data. */
export function prepareDataset(ds) {
  const T = ds.dates?.length;
  if (!T) throw new Error('Dataset has no dates.');
  for (let i = 0; i < T; i++) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ds.dates[i])) throw new Error(`Bad date at row ${i}: ${ds.dates[i]}`);
    if (i > 0 && ds.dates[i] <= ds.dates[i - 1]) throw new Error(`Dates not strictly increasing at ${ds.dates[i]}`);
  }
  const check = (name, arr) => {
    if (!Array.isArray(arr) || arr.length !== T) throw new Error(`Series ${name} length mismatch.`);
    for (let i = 0; i < T; i++) {
      if (typeof arr[i] !== 'number' || !Number.isFinite(arr[i]) || arr[i] <= -1 || arr[i] > 10) {
        throw new Error(`Series ${name} has an invalid value at ${ds.dates[i]}: ${arr[i]}`);
      }
    }
  };
  check('rf', ds.rf);
  check('market', ds.market);
  const assetNames = Object.keys(ds.assets || {});
  if (assetNames.length < 2) throw new Error('Need at least 2 assets.');
  for (const n of assetNames) check(n, ds.assets[n]);
  for (const [n, arr] of Object.entries(ds.factors || {})) check('factor ' + n, arr);
  const fingerprint = sha256Hex(canonicalJson({ dates: ds.dates, rf: ds.rf, market: ds.market, assets: ds.assets, factors: ds.factors || {} }));
  return { ...ds, assetNames, fingerprint, periodsPerYear: ds.periodsPerYear || 12 };
}

/**
 * Work out the common evaluation window for a set of strategies.
 * The first evaluated month is the latest of: the requested start, and the first month at which EVERY strategy has
 * enough history. Nothing starts early just because it needs less data.
 */
export function commonWindow(ds, specs, { start, end } = {}) {
  const warmups = specs.map(s => {
    const strat = getStrategy(s.id);
    return { id: s.id, name: strat.name, months: strat.warmup(validateParams(strat, s.params)) };
  });
  const maxWarm = Math.max(...warmups.map(w => w.months));
  const startIdx = start ? ds.dates.findIndex(d => d >= start) : 0;
  const endIdx = end ? findLastIndex(ds.dates, d => d <= end) : ds.dates.length - 1;
  if (startIdx < 0 || endIdx < 0) throw new Error('Requested dates are outside the dataset.');
  const firstEval = Math.max(startIdx, maxWarm); // decision at firstEval−1 uses rows 0..firstEval−1 (= maxWarm rows)
  if (firstEval > endIdx - 11) throw new Error('Evaluation window shorter than 12 months after warm-up.');
  const binding = warmups.filter(w => w.months === maxWarm && maxWarm > startIdx);
  return { firstEval, endIdx, warmups, bindingWarmup: binding };
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/** Run ONE strategy over [firstEval, endIdx]. Returns per-month series and diagnostics. */
export function runStrategy(ds, spec, window, costs) {
  const strat = getStrategy(spec.id);
  const params = validateParams(strat, spec.params);
  const N = ds.assetNames.length;
  const assets = ds.assetNames.map(n => ds.assets[n]);
  const U = N + 1; // universe: [Market, assets...]
  let drifted = new Array(U).fill(0); // start fully in T-bills
  const out = { dates: [], net: [], excessNet: [], grossExcess: [], turnover: [], costs: [], grossExposure: [], netExposure: [], weights: [], notes: [] };
  const costRate = (costs.tradeCostBps || 0) / 1e4;
  const borrowRate = (costs.borrowBpsPerYear || 0) / 1e4 / ds.periodsPerYear;

  let ruined = false;
  for (let t = window.firstEval - 1; t < window.endIdx; t++) {
    if (ruined) {
      // After a loss of 100% or more the account is gone: no capital, no trading, no further return.
      out.dates.push(ds.dates[t + 1]); out.net.push(0); out.excessNet.push(-ds.rf[t + 1]); out.grossExcess.push(-ds.rf[t + 1]);
      out.turnover.push(0); out.costs.push(0); out.grossExposure.push(0); out.netExposure.push(0); out.weights.push(new Array(U).fill(0));
      continue;
    }
    // The strategy only sees arrays truncated at t (no look-ahead is possible, not merely discouraged).
    const ctx = {
      t, nAssets: N, assetNames: ds.assetNames,
      market: ds.market.slice(0, t + 1), rf: ds.rf.slice(0, t + 1),
      assets: assets.map(a => a.slice(0, t + 1)),
    };
    const res = strat.weights(ctx, params);
    const target = new Array(U).fill(0);
    target[0] = res.market || 0;
    if (res.assets) for (let j = 0; j < N; j++) target[j + 1] = res.assets[j];
    if (!target.every(Number.isFinite)) throw new Error(`${strat.name} produced a non-finite weight at ${ds.dates[t]}.`);
    if (res.note) out.notes.push(`${ds.dates[t]}: ${res.note}`);

    let turnover = 0;
    for (let j = 0; j < U; j++) turnover += Math.abs(target[j] - drifted[j]);
    const rNext = [ds.market[t + 1], ...assets.map(a => a[t + 1])];
    const rf = ds.rf[t + 1];
    let excess = 0, shortGross = 0, gross = 0, net = 0;
    for (let j = 0; j < U; j++) {
      excess += target[j] * (rNext[j] - rf);
      if (target[j] < 0) shortGross += -target[j];
      gross += Math.abs(target[j]);
      net += target[j];
    }
    const borrow = shortGross * borrowRate;
    const tradeCost = turnover * costRate;
    let totalNet = rf + excess - borrow - tradeCost;
    if (totalNet <= -1) {
      totalNet = -1;
      ruined = true;
      out.ruinedAt = ds.dates[t + 1];
      out.notes.push(`${ds.dates[t + 1]}: account wiped out (loss of 100% or more; leverage ${gross.toFixed(1)}x)`);
    }
    // Drift weights to the end of month t+1 (before next rebalance). Portfolio value factor excludes costs.
    const V = 1 + rf + excess - borrow;
    drifted = target.map((w, j) => (w * (1 + rNext[j])) / V);

    out.dates.push(ds.dates[t + 1]);
    out.net.push(totalNet);
    out.excessNet.push(totalNet - rf);
    out.grossExcess.push(excess - borrow);
    out.turnover.push(turnover);
    out.costs.push(tradeCost);
    out.grossExposure.push(gross);
    out.netExposure.push(net);
    out.weights.push(target);
  }
  return { id: spec.id, name: strat.name, params, ...out };
}

/** Conditions that must be identical for two runs to be comparable. */
export function conditionsFor(ds, window, costs, universeNote = 'Market + asset portfolios') {
  const c = {
    dataset: ds.id,
    datasetFingerprint: ds.fingerprint,
    universe: ['Market', ...ds.assetNames],
    universeNote,
    evalStart: ds.dates[window.firstEval],
    evalEnd: ds.dates[window.endIdx],
    rebalance: 'monthly, end of month, signals use data through the rebalance month',
    costs: { mode: costs.mode, tradeCostBps: costs.tradeCostBps, borrowBpsPerYear: costs.borrowBpsPerYear },
    startingPosition: 'T-bills (initial purchase costs are charged to every strategy)',
  };
  return { ...c, hash: sha256Hex(canonicalJson(c)) };
}

/** Throw unless every run shares the same conditions hash; report exactly which fields differ. */
export function assertComparable(runs) {
  const base = runs[0].conditions;
  const diffs = [];
  for (const r of runs.slice(1)) {
    if (r.conditions.hash === base.hash) continue;
    for (const k of Object.keys(base)) {
      if (k === 'hash') continue;
      if (canonicalJson(base[k]) !== canonicalJson(r.conditions[k])) diffs.push({ run: r.name, key: k, expected: base[k], got: r.conditions[k] });
    }
  }
  if (diffs.length) throw new ConditionsMismatchError(diffs);
}

/**
 * Full side-by-side comparison. specs: [{id, params}], options: {start, end, costs, benchmarkId, trials}
 * `trials` = Sharpe ratios (per period) of EVERY configuration tried in the session, for the deflated Sharpe ratio.
 */
export function compare(dsRaw, specs, options = {}) {
  const ds = dsRaw.fingerprint ? dsRaw : prepareDataset(dsRaw);
  if (!specs.length) throw new Error('Pick at least one strategy.');
  const costs = options.costs || COST_PRESETS.realistic;
  const window = commonWindow(ds, specs, options);
  const conditions = conditionsFor(ds, window, costs);
  const runs = specs.map(spec => {
    const run = runStrategy(ds, spec, window, costs);
    run.conditions = conditions;
    run.metrics = computeMetrics(run, ds.periodsPerYear);
    return run;
  });
  assertComparable(runs);

  // Correlations of excess returns.
  const corr = runs.map(a => runs.map(b => correlation(a.excessNet, b.excessNet)));

  // Sharpe-difference tests against the benchmark.
  const bench = runs.find(r => r.id === (options.benchmarkId || 'buy-hold-market')) || runs[0];
  const tests = runs.map(r => (r === bench ? null : { vs: bench.name, ...sharpeDifferenceTest(r.excessNet, bench.excessNet) }));

  // Factor attribution on whatever standard factors the dataset provides.
  const factorNames = ['MktRF', 'SMB', 'HML', 'Mom'].filter(f => ds.factors && ds.factors[f]);
  const fIdx = runs[0].dates.map(d => ds.dates.indexOf(d));
  const attribution = factorNames.length ? runs.map(r => {
    const X = factorNames.map(f => fIdx.map(i => ds.factors[f][i]));
    const fit = olsNeweyWest(r.excessNet, X);
    return { names: ['Alpha (monthly)', ...factorNames], ...fit };
  }) : null;

  // Deflated Sharpe: count every configuration tried this session (at least the ones shown now).
  deflateRuns(runs, options.trials && options.trials.length >= runs.length ? options.trials : runs.map(r => r.metrics.sharpePerPeriod));
  return { dataset: { id: ds.id, title: ds.title, fingerprint: ds.fingerprint, synthetic: !!ds.synthetic }, window, conditions, runs, corr, tests, benchmark: bench.name, attribution };
}

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014) for each run, given the per-period Sharpe ratios of EVERY
 * configuration tried (the trials). Mutates run.metrics.deflatedSharpe / trialsCounted; returns {N, V, sr0}.
 */
export function deflateRuns(runs, trialSRs) {
  const N = trialSRs.length;
  const V = N > 1 ? variance(trialSRs) : 0;
  const sr0 = expectedMaxSharpe(V, N);
  for (const r of runs) {
    r.metrics.deflatedSharpe = N > 1
      ? probabilisticSharpe(r.metrics.sharpePerPeriod, sr0, r.excessNet.length, skewness(r.excessNet), kurtosisRaw(r.excessNet))
      : null;
    r.metrics.trialsCounted = N;
  }
  return { N, V, sr0 };
}
