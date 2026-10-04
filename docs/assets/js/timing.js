// "Can you time the market?" page.
import * as T from '../../engine/timing.js';
import { $, $$, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, loadCitations, citationNode, debounce } from './common.js';
import { initMarketPicker } from './market-data.js';

initPage();

const state = { series: null, p: 0.6, skillCost: 10, rulesCost: 10, dcaMonths: 120, dcaSpread: 12, curve: null, curveKey: '' };
const RULE_IDS = ['buy-hold', 'sma', 'momentum', 'cape', 'random'];
const PAGE = { refs: ['sharpe1975timing', 'faber2007tactical', 'moskowitz2012tsmom', 'campbell1998valuation', 'working1960averages', 'dichev2007dollar', 'shiller_data'] };

function setStatus(kind, text) { $('#tm-status').dataset.state = kind; $('#tm-status-text').textContent = text; }
const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__sub' }, sub));

function core() { // the current series' monthly returns, cash returns and dates
  const s = state.series;
  return { ret: s.ret, cash: s.cash, dates: s.dates };
}

// ---------- 1. skill ----------
const runSkill = debounce(() => {
  const { ret, cash } = core();
  const key = `${state.series.id}|${state.skillCost}`;
  if (state.curveKey !== key) { state.curve = T.breakEvenAccuracy(ret, cash, { nSims: 600, costBps: state.skillCost }); state.curveKey = key; }
  const r = T.skillTimers(ret, cash, { p: state.p, nSims: 2000, costBps: state.skillCost });
  // Break-even: linear interpolation of the 50% crossing on the simulated curve (a simulation estimate).
  const cv = state.curve.curve;
  let be = null;
  for (let i = 1; i < cv.length; i++) if (cv[i - 1].share < 0.5 && cv[i].share >= 0.5) { be = cv[i - 1].p + (0.5 - cv[i - 1].share) / (cv[i].share - cv[i - 1].share) * (cv[i].p - cv[i - 1].p); break; }
  if (be === null && cv[0].share >= 0.5) be = cv[0].p;
  clear($('#skill-stats')).append(
    stat('Timers beating buy-and-hold', fmt(r.shareBeatingBuyHold * 100, 'num', 0) + '%', `at ${fmt(state.p * 100, 'num', 0)}% accuracy, 2,000 simulated timers`),
    stat('Accuracy needed', be ? '≈ ' + fmt(be * 100, 'num', 0) + '%' : 'over 100%', 'for half the timers to beat buy-and-hold (monthly calls; simulation estimate, about ±1 point)'),
    stat('Typical outcome', fmt(Math.exp(r.medianLogRatio), 'x', 2), 'median final wealth ÷ buy-and-hold'),
  );
  makeChart($('#chart-breakeven'), t => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: 30, bottom: 44 },
    title: { text: 'Share of timers beating buy-and-hold', left: 0, top: 0, textStyle: { color: t.ink, fontSize: 13, fontWeight: 600 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`Accuracy ${fmt(state.curve.curve[ps[0].dataIndex].p * 100, 'num', 0)}%`, [{ name: 'Beat buy-and-hold', value: fmt(ps[0].value * 100, 'num', 0) + '%', slot: 0 }]) },
    xAxis: { type: 'category', data: state.curve.curve.map(c => fmt(c.p * 100, 'num', 0) + '%'), name: 'accuracy p', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', min: 0, max: 1, ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => fmt(v * 100, 'num', 0) + '%' } },
    series: [{ type: 'line', data: state.curve.curve.map(c => c.share), showSymbol: false, lineStyle: { color: t.series[0], width: 2 }, itemStyle: { color: t.series[0] },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: t.ink3, type: 'dashed' }, label: { color: t.ink2, formatter: '50%', position: 'insideEndTop' }, data: [{ yAxis: 0.5 }] } }],
  }));
  const rel = r.sortedLogRatios.map(v => Math.exp(v));
  const lo = Math.log(Math.min(...rel)), hi = Math.log(Math.max(...rel));
  const nb = 40, w = (hi - lo) / nb || 1;
  const counts = new Array(nb).fill(0);
  for (const v of rel) counts[Math.min(nb - 1, Math.floor((Math.log(v) - lo) / w))]++;
  const mids = counts.map((_, i) => Math.exp(lo + (i + 0.5) * w));
  makeChart($('#chart-skill'), t => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: 30, bottom: 44 },
    title: { text: `Final wealth ÷ buy-and-hold at ${fmt(state.p * 100, 'num', 0)}% accuracy`, left: 0, top: 0, textStyle: { color: t.ink, fontSize: 13, fontWeight: 600 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`≈ ${fmt(mids[ps[0].dataIndex], 'x', 2)} buy-and-hold`, [{ name: 'Timers', value: fmt(counts[ps[0].dataIndex], 'int'), slot: mids[ps[0].dataIndex] >= 1 ? 1 : 0 }]) },
    xAxis: { type: 'category', data: mids.map(m => fmt(m, 'x', m < 0.1 || m > 10 ? 2 : 2)), name: 'final wealth ÷ buy-and-hold (log scale)', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: 'timers', ...axisStyle(t) },
    series: [{ type: 'bar', barCategoryGap: '6%', data: counts.map((c, i) => ({ value: c, itemStyle: { color: mids[i] >= 1 ? t.diverging[4] : t.diverging[0] } })) }],
  }));
}, 80);

// ---------- 2. missing months ----------
function renderMissing() {
  const { ret, cash } = core();
  const ns = [0, 1, 5, 10, 20, 30];
  const m = T.missingMonths(ret, cash, ns);
  makeChart($('#chart-miss'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 64, right: 16, top: width < 700 ? 56 : 34, bottom: 44 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => '$' + fmt(v, v >= 100 ? 'int' : 'num') },
    xAxis: { type: 'category', data: ns.map(n => (n === 0 ? 'none missed' : `${n} months`)), ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'log', name: 'final value of $1', nameLocation: 'middle', nameGap: 52, ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => '$' + (v >= 1000 ? fmt(v, 'int') : v) } },
    series: [
      { name: 'Missed the best months', type: 'bar', data: m.map(x => x.missBest), itemStyle: { color: t.diverging[0] } },
      { name: 'Missed the worst months', type: 'bar', data: m.map(x => x.missWorst), itemStyle: { color: t.diverging[4] } },
      { name: 'Missed both', type: 'bar', data: m.map(x => x.missBoth), itemStyle: { color: t.ink3 } },
    ],
  }));
  const near = T.bestNearWorst(ret, cash, 20, 6);
  const base = T.bestNearWorstBaseline(ret.length, 20, 6);
  const clustered = near > base + 0.08;
  $('#miss-note').textContent = `Of the 20 best months, ${fmt(near * 100, 'num', 0)}% came within 6 months of one of the 20 worst; if those months were scattered at random it would be about ${fmt(base * 100, 'num', 0)}%. `
    + (clustered ? 'Here the best and worst months cluster together in turbulent periods, so stepping aside to avoid the worst tends to miss many of the best as well.' : 'In these data the best and worst months are not clearly clustered (this dataset may have no volatility clustering, like the synthetic one).');
}

// ---------- 3. rules ----------
function renderRules() {
  const s = state.series;
  const ids = s.cape ? RULE_IDS : RULE_IDS.filter(id => id !== 'cape');
  const res = T.runTimingRules({ dates: s.dates, ret: s.ret, cash: s.cash, cape: s.cape }, ids, { costBps: state.rulesCost });
  const curves = Object.fromEntries(ids.map(id => { let w = 1; return [id, res.rules[id].returns.map(r => (w *= 1 + r))]; }));
  makeChart($('#chart-rules'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 64, right: 16, top: width < 700 ? 72 : 40, bottom: 36 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => '$' + fmt(v, v >= 100 ? 'int' : 'num') },
    xAxis: { type: 'category', data: res.dates, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'log', ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => '$' + (v >= 1000 ? fmt(v, 'int') : v) } },
    series: ids.map((id, i) => ({ name: res.rules[id].name, type: 'line', data: curves[id], showSymbol: false,
      lineStyle: { color: id === 'buy-hold' ? t.ink : t.series[i], width: id === 'buy-hold' ? 2 : 1.5, type: id === 'random' ? 'dotted' : i % 2 ? 'dashed' : 'solid' }, itemStyle: { color: id === 'buy-hold' ? t.ink : t.series[i] } })),
  }));
  const rows = ids.map(id => {
    const r = res.rules[id], x = r.summary;
    return h('tr', {}, h('th', { scope: 'row', class: 'txt' }, r.name),
      h('td', {}, fmt(x.cagr, 'pct', 1)), h('td', {}, fmt(x.vol, 'pct', 1)), h('td', {}, fmt(x.maxDrawdown, 'pct', 0)),
      h('td', {}, fmt(r.timeInMarket * 100, 'num', 0) + '%'), h('td', {}, fmt(r.switches, 'int')), h('td', {}, '$' + fmt(x.terminal, x.terminal >= 100 ? 'int' : 'num')));
  });
  clear($('#rules-table')).appendChild(h('table', { class: 'data' },
    h('caption', { class: 'visually-hidden' }, 'Timing rules compared'),
    h('thead', {}, h('tr', {}, ['Rule', 'Compound yearly return', 'Volatility', 'Worst drawdown', 'Time in stocks', 'Switches', 'Final value of $1'].map((c, i) => h('th', { scope: 'col', class: i ? '' : 'txt' }, c)))),
    h('tbody', {}, rows)));
  let note = `Window ${res.firstDate} to ${res.lastDate} (${res.months} months), ${state.rulesCost} bps per switch.`;
  if (s.priceType === 'monthly average') {
    const pl = T.placeboTrend(s.ret, s.cash, ['sma', 'momentum'], { averaged: true, nSims: 100, costBps: state.rulesCost });
    const pm = T.placeboTrend(s.ret, s.cash, ['sma', 'momentum'], { averaged: false, nSims: 100, costBps: state.rulesCost });
    note += ` Placebo check for averaged prices: on 100 random walks with no predictability, the moving-average rule trailed buy-and-hold by a median ${fmt(-pm.summary.sma.median * 100, 'num', 1)} percentage points a year with month-end prices, but only ${fmt(-pl.summary.sma.median * 100, 'num', 1)} points when prices were averaged within each month like Shiller’s. Averaging alone flatters the rule by about ${fmt((pl.summary.sma.median - pm.summary.sma.median) * 100, 'num', 1)} points a year, so compare its result here with that in mind.`;
  }
  if (!s.cape) note += ' The valuation (CAPE) rule needs earnings data, which only the Shiller dataset has.';
  $('#placebo-note').textContent = note;
}

// ---------- 4. lump sum vs DCA ----------
function renderDca() {
  const { ret, cash } = core();
  const r = T.lumpVsDca(ret, cash, { months: state.dcaMonths, spread: state.dcaSpread });
  const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
  const nb = 40, w = (hi - lo) / nb || 1;
  const counts = new Array(nb).fill(0);
  for (const v of r.ratios) counts[Math.min(nb - 1, Math.floor((v - lo) / w))]++;
  const mids = counts.map((_, i) => lo + (i + 0.5) * w);
  makeChart($('#chart-dca'), t => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: 16, bottom: 44 },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`lump sum ÷ DCA ≈ ${fmt(mids[ps[0].dataIndex], 'num', 3)}`, [{ name: 'Starting months', value: fmt(counts[ps[0].dataIndex], 'int'), slot: mids[ps[0].dataIndex] >= 1 ? 1 : 0 }]) },
    xAxis: { type: 'category', data: mids.map(m => fmt(m, 'num', 2)), name: 'final value: lump sum ÷ spread-out purchase', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: 'starting months', ...axisStyle(t) },
    series: [{ type: 'bar', barCategoryGap: '6%', data: counts.map((c, i) => ({ value: c, itemStyle: { color: mids[i] >= 1 ? t.diverging[4] : t.diverging[0] } })) }],
  }));
  $('#dca-note').textContent = `Investing all at once ended ahead in ${fmt(r.lumpAhead * 100, 'num', 0)}% of the ${fmt(r.windows, 'int')} starting months (median ratio ${fmt(r.medianRatio, 'num', 3)}). Spreading out mostly keeps money in cash longer, which costs the equity premium on average, but it lowers regret after unlucky starts. ${state.series.cash.every(c => c === 0) ? 'Cash earns 0% in this dataset, which slightly favours the lump sum.' : ''}`;
}

function renderAll() {
  setStatus('running', 'Simulating…');
  requestAnimationFrame(() => setTimeout(() => {
    try {
      const t0 = performance.now();
      runSkill(); renderMissing(); renderRules(); renderDca();
      setStatus('idle', `${state.series.dates.length} months · ${fmt((performance.now() - t0) / 1000, 'num', 1)} s`);
    } catch (err) { $('#tm-error').textContent = err.message; setStatus('error', 'Simulation failed'); }
  }, 0));
}

async function boot() {
  $('#skill-p').addEventListener('input', e => { state.p = Number(e.target.value); $('#skill-p-out').textContent = fmt(state.p * 100, 'num', 0) + '%'; runSkill(); });
  $('#skill-cost').addEventListener('change', e => { state.skillCost = Number(e.target.value); runSkill(); });
  $$('#rules-cost [data-bps]').forEach(b => b.addEventListener('click', () => {
    state.rulesCost = Number(b.dataset.bps);
    $$('#rules-cost [data-bps]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderRules();
  }));
  $('#dca-months').addEventListener('change', e => { state.dcaMonths = Number(e.target.value); renderDca(); });
  $('#dca-spread').addEventListener('change', e => { state.dcaSpread = Number(e.target.value); renderDca(); });
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  loadCitations().then(c => {
    clear($('#tm-refs')).append(...PAGE.refs.filter(k => c.get(k)).map(k => h('li', {}, citationNode(c.get(k)))));
  }).catch(() => {});
  await initMarketPicker($('#market-picker'), series => { state.series = series; state.curveKey = ''; renderAll(); }, setStatus);
}
boot().catch(err => { $('#tm-error').textContent = err.message; setStatus('error', err.message); });
