// Module Web Worker: runs the comparison off the main thread so the page stays responsive.
// Messages in:  {type:'dataset', dataset}  ·  {type:'run', id, specs, options, altCosts, trials}
// Messages out: {type:'dataset', id, info} · {type:'result', id, result} · {type:'error', id, message}
import { compare, prepareDataset, deflateRuns, ConditionsMismatchError } from '../../engine/runner.js';
import { wealthIndex, drawdowns } from '../../engine/metrics.js';
import { mean, std } from '../../engine/mathx.js';
import { canonicalJson } from '../../engine/hash.js';

let ds = null;

function rollingSharpe(ex, win = 36, q = 12) {
  const out = new Array(ex.length).fill(null);
  for (let i = win - 1; i < ex.length; i++) {
    const w = ex.slice(i - win + 1, i + 1);
    const s = std(w);
    out[i] = s > 0 ? (mean(w) / s) * Math.sqrt(q) : null;
  }
  return out;
}

/** Wealth for charts: after a wipe-out the account is 0, which a log axis cannot show, so it becomes null. */
function wealthForChart(run) {
  const w = wealthIndex(run.net);
  if (!run.ruinedAt) return w;
  const k = run.dates.indexOf(run.ruinedAt);
  return w.map((v, i) => (i >= k ? null : v));
}

/** One key per configuration tried: the same inputs always give the same Sharpe ratio. */
function configKey(spec, options) {
  return canonicalJson({ id: spec.id, params: spec.params, costs: options.costs, start: options.start || null, end: options.end || null });
}

function slimRun(run) {
  return {
    id: run.id, name: run.name, params: run.params, dates: run.dates, ruinedAt: run.ruinedAt || null,
    metrics: run.metrics, notes: run.notes,
    wealth: wealthForChart(run),
    drawdown: drawdowns(run.net).series,
    // After a wipe-out the account holds nothing; a rolling Sharpe of T-bill shortfalls would be meaningless.
    rolling: run.ruinedAt ? rollingSharpe(run.excessNet).map((v, i) => (i >= run.dates.indexOf(run.ruinedAt) ? null : v)) : rollingSharpe(run.excessNet),
    excessNet: run.excessNet,
    grossExposure: run.grossExposure, netExposure: run.netExposure, weights: run.weights, turnover: run.turnover,
  };
}

self.onmessage = ev => {
  const msg = ev.data;
  try {
    if (msg.type === 'dataset') {
      ds = prepareDataset(msg.dataset);
      self.postMessage({
        type: 'dataset', id: msg.id,
        info: { fingerprint: ds.fingerprint, assetNames: ds.assetNames, first: ds.dates[0], last: ds.dates[ds.dates.length - 1], months: ds.dates.length, factors: Object.keys(ds.factors || {}) },
      });
      return;
    }
    if (msg.type === 'run') {
      if (!ds) throw new Error('No dataset loaded yet.');
      const t0 = performance.now();
      const { specs, options, altCosts } = msg;
      // Session trials: every configuration tried so far on this dataset, plus the ones in this run.
      const trials = { ...(msg.trials || {}) };
      const primary = compare(ds, specs, { ...options, trials: undefined });
      primary.runs.forEach((r, i) => { trials[configKey(specs[i], options)] = r.metrics.sharpePerPeriod; });
      const trialSRs = Object.values(trials);
      const deflation = deflateRuns(primary.runs, trialSRs.length >= primary.runs.length ? trialSRs : primary.runs.map(r => r.metrics.sharpePerPeriod));

      let alt = null;
      if (altCosts) {
        const a = compare(ds, specs, { ...options, costs: altCosts });
        alt = { costs: altCosts, conditionsHash: a.conditions.hash, runs: a.runs.map(r => ({ id: r.id, wealth: wealthForChart(r), ruinedAt: r.ruinedAt || null, metrics: { sharpe: r.metrics.sharpe, cagr: r.metrics.cagr, maxDrawdown: r.metrics.maxDrawdown } })) };
      }
      const result = {
        dataset: primary.dataset, window: primary.window, conditions: primary.conditions,
        runs: primary.runs.map(slimRun), corr: primary.corr, tests: primary.tests, benchmark: primary.benchmark,
        attribution: primary.attribution, alt, deflation, elapsedMs: performance.now() - t0,
      };
      self.postMessage({ type: 'result', id: msg.id, result, trials });
    }
  } catch (err) {
    const details = err instanceof ConditionsMismatchError ? err.differences : undefined;
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err), details });
  }
};
