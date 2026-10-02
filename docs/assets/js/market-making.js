// Avellaneda–Stoikov simulator page. The simulation is small (≈ 200 steps × paths), so it runs on the main thread.
import { simulate, PAPER_TABLES } from '../../engine/sims/avellaneda-stoikov.js';
import { $, $$, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, renderTex, lineKey, debounce } from './common.js';

initPage();

const state = { gamma: 0.1, seed: 1, nSims: 1000 };
const PAPER_GAMMAS = [0.01, 0.1, 1];

function setStatus(kind, text) { $('#mm-status').dataset.state = kind; $('#mm-status-text').textContent = text; }

function syncGammaControls() {
  $('#gamma-out').textContent = fmt(state.gamma, 'num', state.gamma < 0.1 ? 3 : 2);
  $('#gamma').value = Math.log10(state.gamma);
  $$('#gamma-presets [data-gamma]').forEach(b => b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.gamma) - state.gamma) < 1e-9)));
}

const run = debounce(() => {
  setStatus('running', 'Simulating…');
  requestAnimationFrame(() => setTimeout(() => {
    const t0 = performance.now();
    const inv = simulate({ gamma: state.gamma, strategy: 'inventory', seed: state.seed, nSims: state.nSims });
    const sym = simulate({ gamma: state.gamma, strategy: 'symmetric', seed: state.seed, nSims: state.nSims });
    render(inv, sym);
    setStatus('idle', `${fmt(state.nSims, 'int')} sessions per strategy · seed ${state.seed} · ${fmt((performance.now() - t0) / 1000, 'num', 2)} s`);
  }, 0));
}, 150);

function render(inv, sym) {
  renderStats(inv, sym);
  renderPath(inv);
  renderInventory(inv);
  renderHist(inv, sym);
  renderCompare(inv, sym);
}

function renderStats(inv, sym) {
  const box = clear($('#stats'));
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__sub' }, sub));
  box.append(
    stat('Average spread', fmt(inv.avgSpread, 'num', 2), 'ask minus bid, same for both strategies'),
    stat('Mean profit, inventory', fmt(inv.profitMean, 'num', 1), `standard deviation ${fmt(inv.profitStd, 'num', 1)}`),
    stat('Mean profit, symmetric', fmt(sym.profitMean, 'num', 1), `standard deviation ${fmt(sym.profitStd, 'num', 1)}`),
    stat('Final inventory spread', `${fmt(inv.finalQStd, 'num', 1)} vs ${fmt(sym.finalQStd, 'num', 1)}`, 'standard deviation, inventory vs symmetric'),
  );
}

function renderPath(inv) {
  const path = inv.samplePath;
  const x = path.map(p => p.t.toFixed(3));
  // Fixed identities: mid = ink line, reservation = slot 1 dashed, bid = slot 3 solid thin, ask = slot 2 solid thin.
  const series = [
    { key: 's', name: 'Mid price s', slot: null, dash: null },
    { key: 'r', name: 'Reservation price r', slot: 0, dash: [6, 4] },
    { key: 'bid', name: 'Bid (buy quote)', slot: 2, dash: null },
    { key: 'ask', name: 'Ask (sell quote)', slot: 1, dash: null },
  ];
  const el = $('#chart-path');
  const prev = el.previousElementSibling;
  if (prev?.classList.contains('legend-html')) prev.remove();
  el.before(h('div', { class: 'legend-html' }, series.map(s => h('span', {}, s.slot === null ? h('span', { class: 'ink-key', 'aria-hidden': 'true' }) : lineKey(s.slot, s.dash, { width: 22, height: 10 }), s.name))));
  makeChart(el, (t, width) => ({
    ...chartBase(t),
    grid: { left: 10, right: width < 500 ? 10 : 18, top: 14, bottom: 22, containLabel: true },
    tooltip: {
      ...tooltipBase(t), trigger: 'axis',
      formatter: ps => tooltipDom(`t = ${ps[0].axisValue}`, ps.map(p => ({ name: series[p.seriesIndex].name, value: fmt(p.value, 'num', 2), slot: series[p.seriesIndex].slot ?? 6 })), `Inventory: ${path[ps[0].dataIndex].q}`),
    },
    xAxis: { type: 'category', data: x, boundaryGap: false, name: 'time t (session runs from 0 to 1)', nameLocation: 'middle', nameGap: 26, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 11, interval: 39 } },
    yAxis: { type: 'value', scale: true, ...axisStyle(t) },
    series: series.map(s => ({
      name: s.name, type: 'line', data: path.map(p => p[s.key]), showSymbol: false, emphasis: { disabled: true },
      step: s.key === 's' ? 'end' : false,
      lineStyle: { width: s.key === 's' ? 2 : 1.5, color: s.slot === null ? t.ink : t.series[s.slot], type: s.dash || 'solid' },
      itemStyle: { color: s.slot === null ? t.ink : t.series[s.slot] },
    })),
  }));
}

function renderInventory(inv) {
  const path = inv.samplePath;
  makeChart($('#chart-inv'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 10, right: width < 500 ? 10 : 18, top: 14, bottom: 6, containLabel: true },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`t = ${ps[0].axisValue}`, [{ name: 'Inventory', value: String(ps[0].value), slot: 0 }]) },
    xAxis: { type: 'category', data: path.map(p => p.t.toFixed(3)), boundaryGap: false, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 11, interval: 39 } },
    yAxis: { type: 'value', minInterval: 1, ...axisStyle(t), name: 'shares', nameTextStyle: { color: t.ink3, fontSize: 11 } },
    series: [{
      type: 'line', step: 'end', data: path.map(p => p.q), showSymbol: false, lineStyle: { width: 2, color: t.series[0] },
      areaStyle: { color: t.series[0], opacity: 0.1 }, itemStyle: { color: t.series[0] }, emphasis: { disabled: true },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: t.ink3, width: 1, type: 'solid' }, data: [{ yAxis: 0 }] },
    }],
  }));
}

function histogram(values, lo, hi, bins) {
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) { const k = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w))); counts[k]++; }
  return { counts, w };
}

function renderHist(inv, sym) {
  const all = inv.profits.concat(sym.profits).slice().sort((a, b) => a - b);
  const lo = Math.floor(all[Math.floor(all.length * 0.002)] / 5) * 5;
  const hi = Math.ceil(all[Math.ceil(all.length * 0.998) - 1] / 5) * 5;
  const bins = Math.max(10, Math.min(40, Math.round((hi - lo) / 2.5)));
  const hi2 = histogram(inv.profits, lo, hi, bins), hs = histogram(sym.profits, lo, hi, bins);
  const cats = hi2.counts.map((_, k) => (lo + (k + 0.5) * hi2.w).toFixed(1));
  const el = $('#chart-hist');
  const prev = el.previousElementSibling;
  if (prev?.classList.contains('legend-html')) prev.remove();
  el.before(h('div', { class: 'legend-html' },
    h('span', {}, h('span', { class: 'bar-key key-bg-s1', 'aria-hidden': 'true' }), `Inventory strategy (mean ${fmt(inv.profitMean, 'num', 1)})`),
    h('span', {}, h('span', { class: 'bar-key bar-key--hatch key-fg-s2', 'aria-hidden': 'true' }), `Symmetric strategy (mean ${fmt(sym.profitMean, 'num', 1)})`)));
  makeChart(el, (t, width) => ({
    ...chartBase(t),
    grid: { left: 10, right: 18, top: 14, bottom: 22, containLabel: true },
    tooltip: {
      ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.surface2, opacity: 0.5 } },
      formatter: ps => {
        const k = ps[0].dataIndex;
        const a = lo + k * hi2.w, b = a + hi2.w;
        return tooltipDom(`Profit ${fmt(a, 'num', 1)} to ${fmt(b, 'num', 1)}`, [
          { name: 'Inventory', value: `${hi2.counts[k]} sessions`, slot: 0 },
          { name: 'Symmetric', value: `${hs.counts[k]} sessions`, slot: 1 },
        ]);
      },
    },
    xAxis: { type: 'category', data: cats, name: 'profit at the end of the session', nameLocation: 'middle', nameGap: 26, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 11, hideOverlap: true } },
    yAxis: { type: 'value', ...axisStyle(t), name: 'sessions', nameTextStyle: { color: t.ink3, fontSize: 11 } },
    series: [
      { name: 'Inventory', type: 'bar', data: hi2.counts, barGap: '-100%', barCategoryGap: '8%', itemStyle: { color: t.series[0], opacity: 0.55, borderRadius: [2, 2, 0, 0] }, emphasis: { disabled: true } },
      { name: 'Symmetric', type: 'line', step: 'middle', data: hs.counts, showSymbol: false, lineStyle: { width: 2, color: t.series[1] }, itemStyle: { color: t.series[1] }, emphasis: { disabled: true } },
    ],
  }));
}

function renderCompare(inv, sym) {
  const wrap = clear($('#compare-table'));
  const nearest = PAPER_GAMMAS.reduce((a, b) => (Math.abs(Math.log(b / state.gamma)) < Math.abs(Math.log(a / state.gamma)) ? b : a));
  const exact = Math.abs(nearest - state.gamma) < 1e-9;
  $('#tab-sub').textContent = exact
    ? `γ = ${nearest}: the paper reports 1000 sessions (Tables 1–3). Monte Carlo results vary with the seed; the “± 2 s.e.” column shows roughly how far our average can land from the true average by chance.`
    : `The paper only reports γ = 0.01, 0.1 and 1. Choose one of those to compare; the table shows our current results only.`;
  const cols = [
    { k: 'avgSpread', label: 'Average spread', d: 2 },
    { k: 'profitMean', label: 'Mean profit', d: 1, se: r => r.profitStd / Math.sqrt(state.nSims) },
    { k: 'profitStd', label: 'Std. dev. of profit', d: 1 },
    { k: 'finalQMean', label: 'Mean final inventory', d: 2, se: r => r.finalQStd / Math.sqrt(state.nSims) },
    { k: 'finalQStd', label: 'Std. dev. of final inventory', d: 1 },
  ];
  const rows = [];
  for (const [label, ours] of [['Inventory', inv], ['Symmetric', sym]]) {
    const paper = exact ? PAPER_TABLES.find(p => p.gamma === nearest && p.strategy === label.toLowerCase()) : null;
    rows.push(h('tr', {}, h('th', { scope: 'row', class: 'txt' }, `${label}: our simulation`), cols.map(c => h('td', {}, fmt(ours[c.k], 'num', c.d), c.se ? h('span', { class: 'sub' }, `± ${fmt(2 * c.se(ours), 'num', c.d)} (2 s.e.)`) : null))));
    if (paper) rows.push(h('tr', {}, h('th', { scope: 'row', class: 'txt' }, h('span', { class: 'muted' }, `${label}: paper, Table ${{ 0.1: 1, 0.01: 2, 1: 3 }[nearest]}`)), cols.map(c => h('td', {}, h('span', { class: 'muted' }, fmt(paper[c.k], 'num', c.d))))));
  }
  wrap.appendChild(h('table', { class: 'data' },
    h('caption', { class: 'visually-hidden' }, 'Simulation results compared with the paper'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, `γ = ${fmt(state.gamma, 'num', state.gamma < 0.1 ? 3 : 2)}`), cols.map(c => h('th', { scope: 'col' }, c.label)))),
    h('tbody', {}, rows)));
}

function init() {
  $$('#gamma-presets [data-gamma]').forEach(b => b.addEventListener('click', () => { state.gamma = Number(b.dataset.gamma); syncGammaControls(); run(); }));
  $('#gamma').addEventListener('input', e => {
    let g = Math.pow(10, Number(e.target.value));
    g = g < 0.1 ? Math.round(g * 1000) / 1000 : Math.round(g * 100) / 100;
    state.gamma = Math.min(1, Math.max(0.01, g));
    syncGammaControls(); run();
  });
  $('#seed').addEventListener('input', e => {
    const v = Number(e.target.value);
    if (Number.isInteger(v) && v >= 1 && v <= 999999) { state.seed = v; run(); }
  });
  $('#nsims').addEventListener('change', e => { state.nSims = Number(e.target.value); run(); });
  renderTex($('#eq-r'), 'r(s,q,t) = s - q\\,\\gamma\\,\\sigma^{2}\\,(T-t)');
  renderTex($('#eq-s'), '\\delta^{a} + \\delta^{b} = \\gamma\\,\\sigma^{2}\\,(T-t) + \\frac{2}{\\gamma}\\ln\\!\\left(1+\\frac{\\gamma}{k}\\right)');
  $('#eq-r').classList.add('eq__math');
  $('#eq-s').classList.add('eq__math');
  syncGammaControls();
  run();
}

if (typeof echarts === 'undefined' || typeof katex === 'undefined') window.addEventListener('load', init, { once: true });
else init();

