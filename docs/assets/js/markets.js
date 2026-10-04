// "How markets move": fit six return models to one market series and compare them with the stylized facts.
import { MODELS, MODEL_IDS, FACTS, stylizedFacts, lgamma } from '../../engine/models.js';
import { $, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, texNode, loadCitations, citationNode, debounce, MINUS } from './common.js';
import { initMarketPicker } from './market-data.js';

initPage();

const worker = new Worker(new URL('./markets-worker.js', import.meta.url), { type: 'module' });
const state = { series: null, nSims: 200, seed: 1, job: 0 };
const PAGE = { refs: ['cont2001stylized', 'lo1988variance', 'working1960averages', 'ljung1978', 'shiller_data'] };

function setStatus(kind, text) { $('#mk-status').dataset.state = kind; $('#mk-status-text').textContent = text; }

const fmtFact = (id, v) => {
  const f = FACTS.find(x => x.id === id);
  return f.fmt === 'pct' ? fmt(v, 'pct', 1) : f.fmt === 'pct2' ? fmt(v, 'pct', 2) : fmt(v, 'num', 2);
};

const run = debounce(() => {
  if (!state.series) return;
  const x = state.series.ret.map(r => Math.log(1 + r));
  const id = ++state.job;
  $('#mk-error').textContent = '';
  setStatus('running', `Fitting 6 models and simulating ${state.nSims} histories each…`);
  renderReal(x);
  worker.onmessage = ev => {
    if (ev.data.id !== state.job) return;
    if (!ev.data.ok) { $('#mk-error').textContent = ev.data.error; setStatus('error', 'Model fitting failed'); return; }
    renderModels(x, ev.data.fits, ev.data.cmp);
    setStatus('idle', `${x.length} months · ${state.nSims} simulated histories per model · seed ${state.seed} · ${fmt(ev.data.ms / 1000, 'num', 1)} s`);
  };
  worker.postMessage({ id, x, nSims: state.nSims, seed: state.seed });
}, 100);

function renderReal(x) {
  const s = state.series;
  const f = stylizedFacts(x);
  const years = x.length / 12;
  const growth = Math.exp(x.reduce((a, b) => a + b, 0));
  const box = clear($('#stats'));
  const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, label), h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__sub' }, sub));
  const worst = Math.min(...s.ret), best = Math.max(...s.ret);
  box.append(
    stat('Average yearly growth', fmt(Math.pow(growth, 1 / years) - 1, 'pct', 1), `compound, ${s.dates[0]} to ${s.dates[s.dates.length - 1]}`),
    stat('Volatility', fmt(f.volAnn, 'pct', 1), 'standard deviation per year'),
    stat('Worst month', fmt(worst, 'pct', 1), s.dates[s.ret.indexOf(worst)]),
    stat('Best month', fmt(best, 'pct', 1), s.dates[s.ret.indexOf(best)]),
    stat('Worst drawdown', fmt(f.maxDD, 'pct', 0), 'peak to trough'),
  );
  let w = 1;
  const pts = s.ret.map(r => (w *= 1 + r));
  makeChart($('#chart-growth'), t => ({
    ...chartBase(t),
    grid: { left: 64, right: 16, top: 16, bottom: 36 },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(s.dates[ps[0].dataIndex], [{ name: 'Growth of $1', value: '$' + fmt(ps[0].value, 'num', 2), slot: 0 }]) },
    xAxis: { type: 'category', data: s.dates, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'log', ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => '$' + (v >= 1000 ? fmt(v, 'int') : v) } },
    series: [{ type: 'line', data: pts, showSymbol: false, lineStyle: { color: t.ink, width: 1.5 }, itemStyle: { color: t.ink } }],
  }));
}

function renderModels(x, fits, cmp) {
  renderTable(fits, cmp);
  renderHist(x, fits);
  renderAcf(cmp);
  renderPaths(x, cmp);
  renderCards(fits);
}

function renderTable(fits, cmp) {
  const ids = MODEL_IDS;
  const head = h('tr', {}, h('th', { class: 'txt', scope: 'col' }, 'Fact'), h('th', { scope: 'col' }, 'Real data'),
    ids.map(id => h('th', { scope: 'col' }, MODELS[id].short)));
  const mark = v => (v === 'inside' ? '✓' : v === 'above' ? '↑' : v === 'below' ? '↓' : '—');
  const rows = FACTS.map(f => h('tr', {},
    h('th', { scope: 'row', class: 'txt' }, f.label, h('span', { class: 'sub sub--wrap' }, f.explain)),
    h('td', { class: 'strong' }, fmtFact(f.id, cmp.real[f.id])),
    ids.map(id => {
      const b = cmp.models[id].bands[f.id];
      return h('td', { class: `verdict verdict--${b.verdict}`, title: `90% of simulated histories: ${fmtFact(f.id, b.lo)} to ${fmtFact(f.id, b.hi)}` },
        h('span', { class: 'verdict__mark', 'aria-hidden': 'true' }, mark(b.verdict)), ' ',
        h('span', { class: 'visually-hidden' }, b.verdict === 'inside' ? 'reproduced' : `not reproduced (real value ${b.verdict} the range)`),
        h('span', { class: 'sub' }, `${fmtFact(f.id, b.lo)} to ${fmtFact(f.id, b.hi)}`));
    })));
  const best = key => { const v = ids.map(id => fits[id][key]); const m = Math.min(...v); return id => fits[id][key] === m; };
  const isBestAic = best('aic'), isBestBic = best('bic');
  rows.push(h('tr', { class: 'row-summary' }, h('th', { scope: 'row', class: 'txt' }, 'Facts reproduced'), h('td', {}, '—'),
    ids.map(id => h('td', { class: 'strong' }, `${cmp.models[id].reproduced} of ${FACTS.length}`))));
  rows.push(h('tr', {}, h('th', { scope: 'row', class: 'txt' }, 'AIC (lower is better)', h('span', { class: 'sub' }, '2k − 2 log-likelihood')), h('td', {}, '—'),
    ids.map(id => h('td', { class: isBestAic(id) ? 'strong' : '' }, fmt(fits[id].aic, 'num', 0), isBestAic(id) ? h('span', { class: 'sub' }, 'best') : null))));
  rows.push(h('tr', {}, h('th', { scope: 'row', class: 'txt' }, 'BIC (lower is better)', h('span', { class: 'sub' }, 'k ln T − 2 log-likelihood')), h('td', {}, '—'),
    ids.map(id => h('td', { class: isBestBic(id) ? 'strong' : '' }, fmt(fits[id].bic, 'num', 0), isBestBic(id) ? h('span', { class: 'sub' }, 'best') : null))));
  clear($('#facts-table')).appendChild(h('table', { class: 'data facts' },
    h('caption', { class: 'visually-hidden' }, 'Stylized facts of the real data and whether each model reproduces them'),
    h('thead', {}, head), h('tbody', {}, rows)));
}

function renderHist(x, fits) {
  const lo = Math.min(...x), hi = Math.max(...x);
  const nb = 60, w = (hi - lo) / nb;
  const counts = new Array(nb).fill(0);
  for (const v of x) counts[Math.min(nb - 1, Math.floor((v - lo) / w))]++;
  const mids = counts.map((_, i) => lo + (i + 0.5) * w);
  const n = x.length;
  const rw = fits.rw.params, tp = fits.t.params;
  const normalPdf = v => Math.exp(-0.5 * ((v - rw.mu) / rw.sigma) ** 2) / (rw.sigma * Math.sqrt(2 * Math.PI));
  const tPdf = v => Math.exp(lgamma((tp.nu + 1) / 2) - lgamma(tp.nu / 2) - 0.5 * Math.log(tp.nu * Math.PI) - Math.log(tp.scale) - (tp.nu + 1) / 2 * Math.log(1 + ((v - tp.mu) / tp.scale) ** 2 / tp.nu));
  const sq = Math.sqrt;
  makeChart($('#chart-hist'), t => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: 34, bottom: 44 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 }, data: ['Real months', 'Normal (random walk)', 'Student t'] },
    tooltip: { ...tooltipBase(t), trigger: 'axis', formatter: ps => tooltipDom(`log return ≈ ${fmt(mids[ps[0].dataIndex] * 100, 'num', 1)}%`, [
      { name: 'Real months', value: fmt(counts[ps[0].dataIndex], 'int'), slot: 6 },
      { name: 'Normal expects', value: fmt(normalPdf(mids[ps[0].dataIndex]) * n * w, 'num', 1), slot: 0 },
      { name: 't expects', value: fmt(tPdf(mids[ps[0].dataIndex]) * n * w, 'num', 1), slot: 1 }]) },
    xAxis: { type: 'category', data: mids.map(m => fmt(m * 100, 'num', 0) + '%'), name: 'monthly log return', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: '√ months', ...axisStyle(t), axisLabel: { color: t.ink3, formatter: v => fmt(v * v, 'int') } },
    series: [
      { name: 'Real months', type: 'bar', data: counts.map(sq), barCategoryGap: '4%', itemStyle: { color: t.ink3, opacity: 0.55 } },
      { name: 'Normal (random walk)', type: 'line', data: mids.map(m => sq(normalPdf(m) * n * w)), showSymbol: false, smooth: true, lineStyle: { color: t.series[0], width: 2 }, itemStyle: { color: t.series[0] } },
      { name: 'Student t', type: 'line', data: mids.map(m => sq(tPdf(m) * n * w)), showSymbol: false, smooth: true, lineStyle: { color: t.series[1], width: 2, type: 'dashed' }, itemStyle: { color: t.series[1] } },
    ],
  }));
}

function renderAcf(cmp) {
  const lags = Array.from({ length: 12 }, (_, i) => String(i + 1));
  makeChart($('#chart-acf'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 52, right: 16, top: width < 700 ? 64 : 40, bottom: 44 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => fmt(v, 'num', 3) },
    xAxis: { type: 'category', data: lags, name: 'lag k (months)', nameLocation: 'middle', nameGap: 28, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: 'value', name: 'correlation', ...axisStyle(t) },
    series: [
      { name: 'Real data', type: 'bar', data: cmp.real.absAcfLags, itemStyle: { color: t.ink3, opacity: 0.6 }, barCategoryGap: '30%' },
      ...MODEL_IDS.map((id, i) => ({ name: MODELS[id].short, type: 'line', data: cmp.models[id].absAcfLags, showSymbol: true, symbolSize: 5, lineStyle: { color: t.series[i], width: 2, type: i % 2 ? 'dashed' : 'solid' }, itemStyle: { color: t.series[i] } })),
    ],
  }));
}

function renderPaths(x, cmp) {
  const box = clear($('#paths'));
  const cum = arr => { let a = 0; return arr.map(v => Math.exp(a += v)); };
  const real = cum(x);
  MODEL_IDS.forEach((id, i) => {
    const el = h('div', { class: 'chart chart--mini', role: 'img', 'aria-label': `Real growth versus one simulated history of the ${MODELS[id].name} model` });
    box.appendChild(h('figure', { class: 'mini' }, h('figcaption', { class: 'mini__title' }, MODELS[id].short), el));
    const sim = cum(cmp.models[id].example);
    makeChart(el, t => ({
      ...chartBase(t),
      grid: { left: 44, right: 8, top: 8, bottom: 22 },
      tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => '$' + fmt(v, 'num', 1) },
      xAxis: { type: 'category', data: state.series.dates, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 10, interval: Math.floor(x.length / 3) } },
      yAxis: { type: 'log', ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 10, formatter: v => '$' + (v >= 1000 ? fmt(v / 1000, 'int') + 'k' : v) } },
      series: [
        { name: 'Real', type: 'line', data: real, showSymbol: false, lineStyle: { color: t.ink3, width: 1.25 }, itemStyle: { color: t.ink3 } },
        { name: MODELS[id].short, type: 'line', data: sim, showSymbol: false, lineStyle: { color: t.series[i], width: 1.5 }, itemStyle: { color: t.series[i] } },
      ],
    }));
  });
}

function paramList(id, p) {
  const pct = v => fmt(v * 100, 'num', 2) + '%';
  const rows = {
    rw: [['μ (mean log return per month)', pct(p.mu)], ['σ (volatility per month)', pct(p.sigma)]],
    t: [['μ per month', pct(p.mu)], ['scale s per month', pct(p.scale)], ['degrees of freedom ν (lower = fatter tails)', fmt(p.nu, 'num', 1)]],
    jump: [['μ per month', pct(p.mu)], ['σ of normal moves', pct(p.sigma)], ['jumps per year (12λ)', fmt(12 * p.lambda, 'num', 2)], ['average jump μ_J', pct(p.muJ)], ['jump size spread σ_J', pct(p.sigmaJ)]],
    garch: [['α (reaction to last surprise)', fmt(p.alpha, 'num', 3)], ['β (memory of past volatility)', fmt(p.beta, 'num', 3)], ['half-life of a volatility shock', p.alpha + p.beta > 0 ? fmt(Math.log(0.5) / Math.log(p.alpha + p.beta), 'num', 1) + ' months' : '—'], ['long-run volatility per year', p.alpha + p.beta < 1 ? fmt(Math.sqrt(12 * p.omega / (1 - p.alpha - p.beta)), 'pct', 1) : '—']],
    gjr: [['α (reaction to any surprise)', fmt(p.alpha, 'num', 3)], ['γ (extra reaction to falls)', fmt(p.gamma, 'num', 3)], ['β (memory)', fmt(p.beta, 'num', 3)]],
    regime: [['calm regime: μ, σ per month', `${pct(p.mu1)}, ${pct(p.sigma1)}`], ['turbulent regime: μ, σ per month', `${pct(p.mu2)}, ${pct(p.sigma2)}`], ['average calm spell', fmt(1 / (1 - p.p11), 'num', 0) + ' months'], ['average turbulent spell', fmt(1 / (1 - p.p22), 'num', 0) + ' months']],
  }[id];
  return h('dl', { class: 'params' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

async function renderCards(fits) {
  const cites = await loadCitations().catch(() => new Map());
  const box = clear($('#model-cards'));
  MODEL_IDS.forEach((id, i) => {
    const m = MODELS[id], f = fits[id];
    box.appendChild(h('article', { class: 'card model-card', dataset: { slot: String(i) } },
      h('h3', {}, m.name),
      h('p', { class: 'prose' }, m.idea),
      h('div', { class: 'eq' }, texNode(m.tex)),
      h('h4', {}, 'Fitted to this data'),
      paramList(id, f.params),
      h('p', { class: 'small muted' }, `Log-likelihood ${fmt(f.ll, 'num', 1)} with ${f.k} parameters.`),
      h('ul', { class: 'small refs' }, m.cite.map(k => cites.get(k) ? h('li', {}, citationNode(cites.get(k))) : h('li', {}, k)))));
  });
}

async function boot() {
  $('#nsims').addEventListener('change', e => { state.nSims = Number(e.target.value); run(); });
  $('#seed').addEventListener('change', e => { const v = Math.max(1, Math.floor(Number(e.target.value) || 1)); state.seed = v; e.target.value = v; run(); });
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  loadCitations().then(c => clear($('#mk-refs')).append(...PAGE.refs.filter(k => c.get(k)).map(k => h('li', {}, citationNode(c.get(k)))))).catch(() => {});
  await initMarketPicker($('#market-picker'), series => { state.series = series; run(); }, setStatus);
}
boot().catch(err => { $('#mk-error').textContent = err.message; setStatus('error', err.message); });
