// Market-timing simulations on one market series (docs/ENGINE_SPEC.md §11).
//
// Every rule decides at the end of month t, using data through month t only, whether to hold the market or cash
// for month t+1. Switching costs `costBps` per unit of turnover (in → out or out → in = 1 unit).
// Inputs: ret[t] = market total return of month t (index 0 may be null and is skipped), cash[t] = cash return of
// month t (0 when the dataset has no short rate).
import { makeRng, mean, std } from './mathx.js';
import { drawdowns } from './metrics.js';

const ANN = 12;

/** Summary of a monthly return series. */
export function summarize(r) {
  let w = 1; for (const x of r) w *= 1 + x;
  const years = r.length / ANN;
  const dd = drawdowns(r);
  return { terminal: w, cagr: Math.pow(w, 1 / years) - 1, vol: std(r) * Math.sqrt(ANN), maxDrawdown: dd.maxDrawdown, months: r.length };
}

/** Apply a 0/1 position path (pos[t] = held during month t) with switching costs. */
export function applyPositions(ret, cash, pos, costBps = 0) {
  const out = [];
  let prev = 0, switches = 0;
  for (let t = 0; t < ret.length; t++) {
    const p = pos[t];
    const cost = Math.abs(p - prev) * costBps / 1e4;
    if (p !== prev) switches++;
    out.push(p * ret[t] + (1 - p) * cash[t] - cost);
    prev = p;
  }
  return { returns: out, switches };
}

// ---------------------------------------------------------------- 1. How accurate does a timer have to be?
/**
 * A timer that, each month, calls correctly with probability p whether the market will beat cash next month.
 * Correct call: hold whichever does better; wrong call: hold the other. Returns the distribution of terminal
 * wealth over nSims timers relative to buy-and-hold (log ratio), and the share that beat buy-and-hold.
 * This is a thought experiment in the spirit of Sharpe (1975), on monthly rather than annual switching.
 */
export function skillTimers(ret, cash, { p = 0.6, nSims = 2000, costBps = 0, seed = 1 } = {}) {
  const rng = makeRng(seed);
  const bh = ret.reduce((a, r) => a + Math.log(1 + r), 0);
  const rel = [];
  let wins = 0;
  for (let s = 0; s < nSims; s++) {
    let lw = 0, prev = 1;
    for (let t = 0; t < ret.length; t++) {
      const best = ret[t] > cash[t] ? 1 : 0;
      const pos = rng.next() < p ? best : 1 - best;
      lw += Math.log(1 + pos * ret[t] + (1 - pos) * cash[t] - Math.abs(pos - prev) * costBps / 1e4);
      prev = pos;
    }
    rel.push(lw - bh);
    if (lw > bh) wins++;
  }
  rel.sort((a, b) => a - b);
  const q = f => rel[Math.min(rel.length - 1, Math.floor(f * rel.length))];
  return { p, nSims, shareBeatingBuyHold: wins / nSims, medianLogRatio: q(0.5), q05: q(0.05), q95: q(0.95), sortedLogRatios: rel };
}

/** Smallest accuracy p (on a 0.5–1 grid, step 0.01) at which at least half the simulated timers beat buy-and-hold. */
export function breakEvenAccuracy(ret, cash, { nSims = 400, costBps = 0, seed = 1 } = {}) {
  const curve = [];
  let found = null;
  for (let k = 50; k <= 100; k++) {
    const p = k / 100;
    const r = skillTimers(ret, cash, { p, nSims, costBps, seed });
    curve.push({ p, share: r.shareBeatingBuyHold, median: r.medianLogRatio });
    if (found === null && r.shareBeatingBuyHold >= 0.5) found = p;
  }
  return { breakEven: found, curve };
}

// ---------------------------------------------------------------- 2. Missing the best (or worst) months
/** Terminal wealth if the n best (or worst) months are replaced by cash, for n in ns. Perfect hindsight, by design. */
export function missingMonths(ret, cash, ns = [0, 1, 5, 10, 20, 30, 50]) {
  const idx = ret.map((r, i) => i);
  const byBest = idx.slice().sort((a, b) => (ret[b] - cash[b]) - (ret[a] - cash[a]));
  const byWorst = byBest.slice().reverse();
  const run = drop => { const set = new Set(drop); let w = 1; for (let t = 0; t < ret.length; t++) w *= 1 + (set.has(t) ? cash[t] : ret[t]); return w; };
  return ns.map(n => ({ n, missBest: run(byBest.slice(0, n)), missWorst: run(byWorst.slice(0, n)), missBoth: run([...byBest.slice(0, n), ...byWorst.slice(0, n)]) }));
}

/** The same share when the n best and n worst months are placed at random (simulation): the no-clustering baseline. */
export function bestNearWorstBaseline(T, n = 20, k = 6, { nSims = 2000, seed = 3 } = {}) {
  const rng = makeRng(seed);
  let tot = 0;
  for (let s = 0; s < nSims; s++) {
    const idx = Array.from({ length: T }, (_, i) => i);
    for (let i = 0; i < 2 * n; i++) { const j = i + Math.floor(rng.next() * (T - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const best = idx.slice(0, n), worst = idx.slice(n, 2 * n);
    tot += best.filter(b => worst.some(w => Math.abs(w - b) <= k)).length / n;
  }
  return tot / nSims;
}

/** How close together the best and worst months are: share of the n best months within k months of one of the n worst. */
export function bestNearWorst(ret, cash, n = 20, k = 6) {
  const idx = ret.map((r, i) => i).sort((a, b) => (ret[b] - cash[b]) - (ret[a] - cash[a]));
  const best = idx.slice(0, n), worst = idx.slice(-n);
  return best.filter(b => worst.some(w => Math.abs(w - b) <= k)).length / n;
}

// ---------------------------------------------------------------- 3. Rule-based timers (decide at t, hold t+1)
export const TIMING_RULES = {
  'buy-hold': { name: 'Buy and hold', cite: [], position: () => 1 },
  sma: {
    name: 'Price above its 10-month average (Faber)', cite: ['faber2007tactical'],
    position: (ctx, { L = 10 } = {}) => {
      if (ctx.t < L - 1) return null;
      let lvl = 1; const levels = [];
      for (let i = ctx.t - L + 1; i <= ctx.t; i++) { lvl *= 1 + ctx.ret[i]; levels.push(lvl); }
      return levels[L - 1] > mean(levels) ? 1 : 0;
    },
  },
  momentum: {
    name: 'Past 12-month return above cash (time-series momentum)', cite: ['moskowitz2012tsmom'],
    position: (ctx, { k = 12 } = {}) => {
      if (ctx.t < k - 1) return null;
      let a = 1, b = 1;
      for (let i = ctx.t - k + 1; i <= ctx.t; i++) { a *= 1 + ctx.ret[i]; b *= 1 + ctx.cash[i]; }
      return a > b ? 1 : 0;
    },
  },
  cape: {
    name: 'Valuation: CAPE below its own past median', cite: ['campbell1998valuation'],
    needs: 'cape',
    position: (ctx, { lag = 6, minHistory = 120 } = {}) => {
      const t = ctx.t - lag;
      if (!ctx.cape || t < 0 || ctx.cape[t] == null) return null;
      const hist = [];
      for (let i = 0; i <= t; i++) if (ctx.cape[i] != null) hist.push(ctx.cape[i]);
      if (hist.length < minHistory) return null;
      hist.sort((a, b) => a - b);
      const med = hist[Math.floor((hist.length - 1) / 2)];
      return ctx.cape[t] < med ? 1 : 0;
    },
  },
  random: {
    name: 'Coin flip each month (no skill; one random draw)', cite: [],
    position: ctx => (ctx.rng.next() < 0.5 ? 1 : 0),
  },
};

/**
 * Run all rules on one series over a COMMON window: the first month at which every rule has a position.
 * series: { dates, ret, cash, cape? } (aligned; ret[0] may be null). Returns per rule: returns, switches, summary.
 */
export function runTimingRules(series, ids, { costBps = 10, params = {}, seed = 7 } = {}) {
  const n = series.ret.length;
  const rng = makeRng(seed);
  const positions = Object.fromEntries(ids.map(id => [id, new Array(n).fill(null)]));
  // The context arrays GROW by one month per step, so at decision t a rule can only ever see rows 0..t.
  const ctx = { t: 0, ret: [], cash: [], cape: series.cape ? [] : null, rng };
  for (let t = 0; t < n - 1; t++) {
    ctx.t = t;
    ctx.ret.push(series.ret[t] ?? 0); ctx.cash.push(series.cash[t]);
    if (ctx.cape) ctx.cape.push(series.cape[t]);
    if (t === 0) continue;
    for (const id of ids) positions[id][t + 1] = TIMING_RULES[id].position(ctx, params[id] || {}); // decided at t, held in t+1
  }
  let first = 1;
  for (const id of ids) {
    const f = positions[id].findIndex((p, i) => i >= 1 && p !== null);
    if (f < 0) throw new Error(`${TIMING_RULES[id].name}: no usable months (does the dataset have what it needs?).`);
    first = Math.max(first, f);
  }
  const ret = series.ret.slice(first), cash = series.cash.slice(first);
  const out = { firstDate: series.dates[first], lastDate: series.dates[n - 1], months: n - first, dates: series.dates.slice(first), rules: {} };
  for (const id of ids) {
    const pos = positions[id].slice(first).map(p => (p === null ? 1 : p));
    const { returns, switches } = applyPositions(ret, cash, pos, costBps);
    out.rules[id] = { id, name: TIMING_RULES[id].name, returns, positions: pos, switches, timeInMarket: mean(pos), summary: summarize(returns) };
  }
  return out;
}

/**
 * Placebo test: run trend rules on random walks with no predictability, matched to the data's mean and volatility.
 * averaged = true mimics Shiller's monthly AVERAGE prices (21 daily steps averaged per month). Returns, per rule,
 * the distribution of CAGR(rule) − CAGR(buy-and-hold) over nSims random histories of the same length.
 */
export function placeboTrend(ret, cash, ruleIds, { averaged = true, nSims = 100, costBps = 10, seed = 11, days = 21 } = {}) {
  const lr = ret.map(r => Math.log(1 + r));
  const mu = mean(lr);
  // Differences of monthly averages have about 2/3 of the variance of month-end differences, so scale up.
  const sd = std(lr) * (averaged ? Math.sqrt(3 / 2) : 1);
  const rng = makeRng(seed);
  const gaps = Object.fromEntries(ruleIds.map(id => [id, []]));
  const n = ret.length;
  for (let s = 0; s < nSims; s++) {
    const sim = [null];
    let level = 0, prevPrice = null;
    for (let m = 0; m <= n; m++) {
      let price;
      if (averaged) {
        let acc = 0;
        for (let d = 0; d < days; d++) { level += mu / days + sd / Math.sqrt(days) * rng.normal(); acc += Math.exp(level); }
        price = acc / days;
      } else { level += mu + sd * rng.normal(); price = Math.exp(level); }
      if (prevPrice !== null) sim.push(price / prevPrice - 1);
      prevPrice = price;
    }
    const dates = sim.map((_, i) => String(i));
    const res = runTimingRules({ dates, ret: sim.slice(0, n + 1), cash: [0, ...cash].slice(0, n + 1) }, ['buy-hold', ...ruleIds], { costBps });
    for (const id of ruleIds) gaps[id].push(res.rules[id].summary.cagr - res.rules['buy-hold'].summary.cagr);
  }
  const summary = {};
  for (const id of ruleIds) {
    const g = gaps[id].slice().sort((a, b) => a - b);
    summary[id] = { median: g[Math.floor(g.length / 2)], q05: g[Math.floor(0.05 * g.length)], q95: g[Math.floor(0.95 * g.length)], shareBeating: g.filter(v => v > 0).length / g.length };
  }
  return { averaged, nSims, summary };
}

// ---------------------------------------------------------------- 4. Lump sum vs dollar-cost averaging
/**
 * Over every rolling window of `months`, compare investing a lump sum at the start with investing it in equal
 * monthly instalments over the first `spread` months (uninvested money earns cash). Returns the share of windows
 * in which the lump sum ended ahead, and each window's ratio of final wealth (lump / DCA).
 */
export function lumpVsDca(ret, cash, { months = 120, spread = 12 } = {}) {
  const ratios = [];
  for (let s = 0; s + months <= ret.length; s++) {
    let lump = 1;
    for (let t = s; t < s + months; t++) lump *= 1 + ret[t];
    let invested = 0, idle = 1;
    for (let t = s; t < s + months; t++) {
      const k = t - s;
      if (k < spread) { const add = 1 / spread; invested += add; idle -= add; }
      invested *= 1 + ret[t];
      idle *= 1 + cash[t];
    }
    ratios.push(lump / (invested + idle));
  }
  return { windows: ratios.length, lumpAhead: ratios.filter(r => r > 1).length / ratios.length, medianRatio: ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length / 2)], ratios };
}
