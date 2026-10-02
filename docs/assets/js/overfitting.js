// Backtest-overfitting page: run every setting of one strategy on identical conditions, then CSCV (spec §8).
import { fetchLocalDataset, makeSyntheticDataset } from '../../engine/data/loaders.js';
import { COST_PRESETS } from '../../engine/runner.js';
import { cscv, sweep, deflatedBest } from '../../engine/overfit.js';
import { getStrategy } from '../../engine/strategies/index.js';
import { $, $$, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, renderTex, debounce, MINUS } from './common.js';

initPage();

const ANN = Math.sqrt(12);
const range = (a, b, step = 1) => { const out = []; for (let x = a; x <= b + 1e-9; x += step) out.push(Math.round(x * 100) / 100); return out; };

const EXPERIMENTS = [
  { id: 'faber', strategy: 'faber-sma', label: 'Moving-average timing: length 2–24 months', sets: range(2, 24).map(L => ({ L })),
    hint: '23 settings. Faber’s published choice is 10 months.' },
  { id: 'tsmom', strategy: 'tsmom', label: 'Time-series momentum: lookback 1–24 months', sets: range(1, 24).map(lookback => ({ lookback })),
    hint: '24 settings. Moskowitz, Ooi & Pedersen’s headline is 12 months.' },
  { id: 'xsmom', strategy: 'xs-momentum', label: 'Cross-sectional momentum: J 1–12 × K {1, 3, 6, 9, 12}',
    sets: range(1, 12).flatMap(J => [1, 3, 6, 9, 12].map(K => ({ J, K }))),
    hint: '60 settings. Jegadeesh & Titman’s grid is J, K ∈ {3, 6, 9, 12}.' },
  { id: 'pairs', strategy: 'ggr-pairs', label: 'Pairs trading: trigger 0.5–3σ × formation {6, 12, 24}',
    sets: [6, 12, 24].flatMap(F => range(0.5, 3, 0.25).map(k => ({ F, k }))),
    hint: '33 settings. Gatev et al. use 2σ and 12 months.' },
];

const state = { exp: 'faber', costs: 'realistic', S: 16, ds: null, source: null, cache: new Map() };

function setStatus(kind, text) { $('#of-status').dataset.state = kind; $('#of-status-text').textContent = text; }

const run = debounce(() => {
  const exp = EXPERIMENTS.find(e => e.id === state.exp);
  $('#experiment-hint').textContent = exp.hint;
  $('#of-error').textContent = '';
  setStatus('running', `Running ${exp.sets.length} settings…`);
  requestAnimationFrame(() => setTimeout(() => {
    try {
      const t0 = performance.now();
      const key = `${exp.id}|${state.costs}`;
      let sw = state.cache.get(key);
      if (!sw) { sw = sweep(state.ds, exp.strategy, exp.sets, { costs: COST_PRESETS[state.costs] }); state.cache.set(key, sw); }
      const res = cscv(sw.columns, { S: state.S });
      const dsr = deflatedBest(sw.columns, sw.sharpe);
      render(exp, sw, res, dsr);
      setStatus('idle', `${exp.sets.length} settings · ${fmt(res.combinations, 'int')} splits · ${sw.dates[0]} to ${sw.dates[sw.dates.length - 1]} · ${fmt((performance.now() - t0) / 1000, 'num', 1)} s`);
    } catch (err) {
      $('#of-error').textContent = err.message;
      setStatus('error', 'Could not run this experiment');
    }
  }, 0));
}, 120);

function render(exp, sw, res, dsr) {
  renderStats(exp, sw, res, dsr);
  const note = $('#of-note');
  note.hidden = !(res.pbo < 0.25 && res.probLoss > 0.5);
  note.textContent = 'A low probability of overfitting only says the ranking of settings is stable from one half of the months to the other. Here the in-sample winner still loses money out of sample in most splits: a stable ranking of losing settings is not a profitable strategy.';
  renderSplit(exp, sw);
  renderLambda(res);
  renderDegradation(res);
}

function renderStats(exp, sw, res, dsr) {
  const box = clear($('#stats'));
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__sub' }, sub));
  box.append(
    stat('Probability of overfitting', fmt(res.pbo * 100, 'num', 0) + '%', 'share of splits where the in-sample winner falls to the bottom half'),
    stat('Probability of loss', fmt(res.probLoss * 100, 'num', 0) + '%', 'share of splits where the winner loses money out of sample (excess of T-bills)'),
    stat('Best setting, full period', sw.labels[dsr.best], `Sharpe ${fmt(sw.sharpe[dsr.best] * ANN, 'num', 2)} (annualized)`),
    stat('Deflated Sharpe of the best', fmt(dsr.dsr, 'num', 2), `confidence it beats the best of ${dsr.N} lucky tries; 0.95 is the usual bar`),
    stat('Months × settings', `${res.T} × ${res.N}`, `${res.S} blocks of ${res.blockLength} months${res.droppedRows ? `; first ${res.droppedRows} months unused` : ''}`),
  );
}

function renderSplit(exp, sw) {
  const T = sw.columns[0].length, half = Math.floor(T / 2);
  const sr = (c, a, b) => { const x = c.slice(a, b); const m = x.reduce((s, v) => s + v, 0) / x.length; const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); return sd > 0 ? m / sd * ANN : 0; };
  const rows = sw.columns.map((c, i) => ({ label: sw.labels[i], a: sr(c, 0, half), b: sr(c, half, T) })).sort((x, y) => y.a - x.a);
  const firstHalf = `${sw.dates[0]} to ${sw.dates[half - 1]}`, secondHalf = `${sw.dates[half]} to ${sw.dates[T - 1]}`;
  makeChart($('#chart-split'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 48, right: 16, top: width < 700 ? 64 : 40, bottom: width < 600 ? 70 : 90 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 }, data: [`First half (${firstHalf}): picks the order`, `Second half (${secondHalf})`] },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(rows[ps[0].dataIndex].label, [
      { name: 'First half', value: fmt(rows[ps[0].dataIndex].a, 'num', 2), slot: 0 },
      { name: 'Second half', value: fmt(rows[ps[0].dataIndex].b, 'num', 2), slot: 1 },
    ], ps[0].dataIndex === 0 ? 'The first-half winner' : null) },
    xAxis: { type: 'category', data: rows.map(r => r.label), ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 10, rotate: 60, interval: rows.length > 30 ? 'auto' : 0 } },
    yAxis: { type: 'value', name: 'Sharpe ratio (annualized)', nameLocation: 'middle', nameGap: 36, ...axisStyle(t) },
    series: [
      { name: `First half (${firstHalf}): picks the order`, type: 'bar', data: rows.map((r, i) => ({ value: r.a, itemStyle: { color: t.series[0], opacity: i === 0 ? 1 : 0.55 } })), barGap: '-100%', barCategoryGap: '25%' },
      { name: `Second half (${secondHalf})`, type: 'bar', data: rows.map(r => r.b), itemStyle: { color: 'transparent', borderColor: t.series[1], borderWidth: 2 } },
    ],
  }));
}

function renderLambda(res) {
  const lam = res.results.map(r => r.lambda);
  const lo = Math.min(...lam), hi = Math.max(...lam);
  const nb = 30, edge = Math.max(Math.abs(lo), Math.abs(hi)) || 1, w = (2 * edge) / nb;
  const counts = new Array(nb).fill(0);
  for (const x of lam) counts[Math.min(nb - 1, Math.floor((x + edge) / w))]++;
  const mids = counts.map((_, i) => -edge + (i + 0.5) * w);
  makeChart($('#chart-lambda'), t => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: 48, bottom: 44 },
    title: { text: `PBO = ${fmt(res.pbo * 100, 'num', 0)}% of ${fmt(res.combinations, 'int')} splits`, left: 'center', top: 0, textStyle: { color: t.ink, fontSize: 13, fontWeight: 600 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`λ ≈ ${fmt(mids[ps[0].dataIndex], 'num', 2)}`, [{ name: 'Splits', value: fmt(counts[ps[0].dataIndex], 'int'), slot: mids[ps[0].dataIndex] <= 0 ? 0 : 1 }]) },
    xAxis: { type: 'category', data: mids.map(m => fmt(m, 'num', 1)), name: 'λ (below 0: winner fell to the bottom half)', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: 'splits', nameLocation: 'middle', nameGap: 40, ...axisStyle(t) },
    series: [{ type: 'bar', barCategoryGap: '8%', data: counts.map((c, i) => ({ value: c, itemStyle: { color: mids[i] <= 0 ? t.diverging[0] : t.diverging[4] } })) }],
  }));
}

function renderDegradation(res) {
  const pts = res.results.map(r => [r.isSharpe * ANN, r.oosSharpe * ANN]);
  const xs = pts.map(p => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const { slope, intercept, r2 } = res.degradation;
  makeChart($('#chart-deg'), t => ({
    ...chartBase(t),
    grid: { left: 56, right: 16, top: 48, bottom: 48 },
    title: { text: `Fitted line: out = ${fmt(intercept * ANN, 'num', 2)} ${slope < 0 ? MINUS : '+'} ${fmt(Math.abs(slope), 'num', 2)} × in   (R² ${fmt(r2, 'num', 2)})`, left: 'center', top: 0, textStyle: { color: t.ink, fontSize: 13, fontWeight: 600 } },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: p => p.seriesIndex === 0 ? tooltipDom('One split', [{ name: 'In sample', value: fmt(p.value[0], 'num', 2), slot: 0 }, { name: 'Out of sample', value: fmt(p.value[1], 'num', 2), slot: 1 }]) : '' },
    xAxis: { type: 'value', scale: true, name: 'in-sample Sharpe of the winner', nameLocation: 'middle', nameGap: 28, ...axisStyle(t) },
    yAxis: { type: 'value', scale: true, name: 'out-of-sample', nameLocation: 'middle', nameGap: 40, ...axisStyle(t) },
    series: [
      { type: 'scatter', large: pts.length > 2000, symbolSize: 4, data: pts, itemStyle: { color: t.series[0], opacity: 0.35 } },
      { type: 'line', showSymbol: false, data: [[x0, (intercept + slope * x0 / ANN) * ANN], [x1, (intercept + slope * x1 / ANN) * ANN]], lineStyle: { color: t.ink, width: 2 }, silent: true },
    ],
  }));
}

async function boot() {
  const sel = $('#experiment');
  for (const e of EXPERIMENTS) sel.appendChild(h('option', { value: e.id }, e.label));
  sel.addEventListener('change', () => { state.exp = sel.value; run(); });
  $$('#costs [data-costs]').forEach(b => b.addEventListener('click', () => {
    state.costs = b.dataset.costs;
    $$('#costs [data-costs]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    run();
  }));
  $('#blocks').addEventListener('change', e => { state.S = Number(e.target.value); run(); });
  renderTex($('#eq-omega'), 'n^* = \\arg\\max_n R_n^{\\text{in}},\\quad \\omega = \\frac{\\rho\\big(R^{\\text{out}}_{n^*}\\big)}{N+1},\\quad \\lambda = \\ln\\frac{\\omega}{1-\\omega}');
  renderTex($('#eq-pbo'), '\\text{PBO} = \\frac{\\#\\{\\text{splits with } \\lambda \\le 0\\}}{\\binom{S}{S/2}}');
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  let local = null;
  try { local = await fetchLocalDataset(); } catch { local = null; }
  state.ds = local || makeSyntheticDataset(7);
  state.source = local ? 'local' : 'synthetic';
  $('#synthetic-banner').hidden = !!local;
  $('#of-data').textContent = local
    ? `Data: ${state.ds.title} (your local copy).`
    : 'Data: the synthetic dataset (seed 7), the same one the Showdown page uses when no real data are loaded.';
  for (const e of EXPERIMENTS) getStrategy(e.strategy); // fail early if a strategy id is wrong
  run();
}
boot().catch(err => { $('#of-error').textContent = err.message; setStatus('error', err.message); });
