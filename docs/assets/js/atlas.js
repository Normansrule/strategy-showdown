// Algorithm atlas page + Almgren–Chriss execution simulation.
import { ATLAS, FAMILIES } from './atlas-data.js';
import { optimalTrajectory, expectedCost, costVariance, frontier } from '../../engine/execution.js';
import { $, $$, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, texNode, loadCitations, citationNode, debounce } from './common.js';

initPage();

const STATUS = {
  runs: { label: 'Runs on real data here', cls: 'chip--ev-runs' },
  simulated: { label: 'Simulated here', cls: 'chip--sim' },
  explained: { label: 'Explained only', cls: 'chip--ev-expl' },
};
const state = { family: '', status: '', lambda: 1e-6 };

async function renderAtlas() {
  const cites = await loadCitations().catch(() => new Map());
  const box = clear($('#atlas'));
  const items = ATLAS.filter(a => (!state.family || a.family === state.family) && (!state.status || a.status === state.status));
  $('#at-count').textContent = `${items.length} of ${ATLAS.length} entries`;
  for (const fam of FAMILIES) {
    const list = items.filter(a => a.family === fam.id);
    if (!list.length) continue;
    box.appendChild(h('section', { class: 'atlas-family', 'aria-labelledby': `fam-${fam.id}` },
      h('h2', { id: `fam-${fam.id}` }, fam.name),
      h('div', { class: 'atlas-grid' }, list.map(a => h('article', { class: 'card atlas-card', id: `algo-${a.id}` },
        h('div', { class: 'atlas-card__head' }, h('h3', {}, a.name), h('span', { class: `chip ${STATUS[a.status].cls}` }, STATUS[a.status].label)),
        h('p', { class: 'prose' }, a.what),
        a.tex ? h('div', { class: 'eq' }, texNode(a.tex)) : null,
        h('p', { class: 'small' }, h('b', {}, 'Commonly used by: '), a.who),
        a.refs.length ? h('ul', { class: 'small refs' }, a.refs.map(k => h('li', {}, cites.get(k) ? citationNode(cites.get(k)) : k))) : null,
        a.link ? h('p', { class: 'small' }, h('a', { href: a.link }, a.status === 'explained' ? 'Read more' : 'Run it')) : null)))));
  }
}

// ---------- Almgren–Chriss (paper's Table 1) ----------
const AC = { X: 1e6, T: 5, N: 5, sigma: 0.95, eps: 0.0625, eta: 2.5e-6, gamma: 2.5e-7 };
const S0 = 50;
const renderExecution = debounce(() => {
  const tau = AC.T / AC.N;
  const etaT = AC.eta - 0.5 * AC.gamma * tau;
  const kappa = Math.acosh(1 + state.lambda * AC.sigma ** 2 / etaT * tau * tau / 2) / tau;
  const twap = optimalTrajectory({ ...AC, lambda: 0 });
  const opt = optimalTrajectory({ ...AC, lambda: state.lambda });
  const now = [AC.X, ...new Array(AC.N).fill(0)];
  const cost = x => ({ E: expectedCost(x, { ...AC, tau }), sd: Math.sqrt(costVariance(x, { ...AC, tau })) });
  const c = { twap: cost(twap), opt: cost(opt), now: cost(now) };
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__sub' }, sub));
  const pct = d => fmt(d / (AC.X * S0) * 100, 'num', 2) + '% of the order';
  clear($('#ex-stats')).append(
    stat('Optimal schedule: expected cost', '$' + fmt(c.opt.E / 1000, 'num', 0) + 'k', `± $${fmt(c.opt.sd / 1000, 'num', 0)}k (1 s.d.); ${pct(c.opt.E)}`),
    stat('Equal slices (TWAP)', '$' + fmt(c.twap.E / 1000, 'num', 0) + 'k', `± $${fmt(c.twap.sd / 1000, 'num', 0)}k`),
    stat('Sell everything on day 1', '$' + fmt(c.now.E / 1000, 'num', 0) + 'k', '± $0: no price risk, maximum impact'),
    stat('κ (urgency) / half-life', `${fmt(kappa, 'num', 2)} per day`, `θ = 1/κ = ${fmt(1 / kappa, 'num', 1)} days (the paper’s “half-life”; holdings fall by a factor e over θ)`),
  );
  const days = Array.from({ length: AC.N + 1 }, (_, j) => `day ${j}`);
  makeChart($('#chart-traj'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 64, right: 16, top: width < 600 ? 60 : 36, bottom: 32 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => fmt(v, 'int') + ' shares' },
    xAxis: { type: 'category', data: days, boundaryGap: false, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: 'shares still held', ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => fmt(v / 1000, 'int') + 'k' } },
    series: [
      { name: 'Equal slices (TWAP)', type: 'line', data: twap, lineStyle: { color: t.series[1], type: 'dashed', width: 2 }, itemStyle: { color: t.series[1] } },
      { name: `Optimal at λ = ${state.lambda.toExponential(1)}`, type: 'line', data: opt, lineStyle: { color: t.series[0], width: 2.5 }, itemStyle: { color: t.series[0] } },
      { name: 'All on day 1', type: 'line', step: 'start', data: now, lineStyle: { color: t.ink3, width: 1.5, type: 'dotted' }, itemStyle: { color: t.ink3 } },
    ],
  }));
  const lams = Array.from({ length: 41 }, (_, i) => Math.pow(10, -8 + i * 0.1));
  const fr = frontier(AC, lams);
  makeChart($('#chart-frontier'), t => ({
    ...chartBase(t),
    grid: { left: 72, right: 16, top: 36, bottom: 44 },
    title: { text: 'Efficient frontier: average cost vs risk', left: 0, top: 0, textStyle: { color: t.ink, fontSize: 13, fontWeight: 600 } },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: p => tooltipDom(`λ = ${Number(p.data[2]).toExponential(1)}`, [{ name: 'Expected cost', value: '$' + fmt(p.data[1], 'int'), slot: 0 }, { name: 'Std. dev. of cost', value: '$' + fmt(p.data[0], 'int'), slot: 0 }]) },
    xAxis: { type: 'value', name: 'standard deviation of cost ($)', nameLocation: 'middle', nameGap: 28, ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => fmt(v / 1000, 'int') + 'k' } },
    yAxis: { type: 'value', scale: true, name: 'expected cost ($)', nameLocation: 'middle', nameGap: 52, ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => fmt(v / 1000, 'int') + 'k' } },
    series: [
      { type: 'line', data: fr.map(p => [Math.sqrt(p.V), p.E, p.lambda]), showSymbol: false, lineStyle: { color: t.series[0], width: 2 } },
      { type: 'scatter', data: [[c.opt.sd, c.opt.E, state.lambda]], symbolSize: 12, itemStyle: { color: t.series[0] } },
      { type: 'scatter', data: [[c.twap.sd, c.twap.E, 0]], symbolSize: 10, symbol: 'diamond', itemStyle: { color: t.series[1] } },
    ],
  }));
}, 30);

async function boot() {
  const sel = $('#at-family');
  for (const f of FAMILIES) sel.appendChild(h('option', { value: f.id }, f.name));
  sel.addEventListener('change', () => { state.family = sel.value; renderAtlas(); });
  $$('#at-status [data-status]').forEach(b => b.addEventListener('click', () => {
    state.status = b.dataset.status;
    $$('#at-status [data-status]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderAtlas();
  }));
  $('#ex-lambda').addEventListener('input', e => { state.lambda = Math.pow(10, Number(e.target.value)); $('#ex-lambda-out').textContent = state.lambda.toExponential(1).replace('-', '−'); renderExecution(); });
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  await renderAtlas();
  renderExecution();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
boot();
