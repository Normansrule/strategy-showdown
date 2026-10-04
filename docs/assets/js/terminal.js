// Terminal page: a command line over the same engine as the other pages. Command names are this project's own.
import { compare, COST_PRESETS } from '../../engine/runner.js';
import { STRATEGIES, getStrategy, defaultParams } from '../../engine/strategies/index.js';
import { fetchLocalDataset, makeSyntheticDataset } from '../../engine/data/loaders.js';
import { loadShiller } from '../../engine/data/shiller.js';
import { MODELS, MODEL_IDS, FACTS, fitAll, compareFacts, stylizedFacts } from '../../engine/models.js';
import * as T from '../../engine/timing.js';
import { cscv, sweep } from '../../engine/overfit.js';
import { ATLAS, FAMILIES } from './atlas-data.js';
import { fromFrench, fromShiller, fromSynthetic } from './market-data.js';
import { $, h, clear, fmt, initPage, makeChart, chartBase, axisStyle, tooltipBase, loadCitations } from './common.js';

initPage();

const out = $('#term-out'), input = $('#term-in');
const state = { showdownDs: null, dsLabel: '', market: null, history: [], hIdx: 0, lastChart: null };
const ANN = Math.sqrt(12);

// ---------------------------------------------------------------- output helpers (text only, never HTML)
const line = (text = '', cls = '') => { const el = h('div', { class: `term__row ${cls}` }, text); out.appendChild(el); out.scrollTop = out.scrollHeight; return el; };
const ok = t => line(t, 'term__ok');
const warn = t => line(t, 'term__warn');
const err = t => line(t, 'term__err');
const dim = t => line(t, 'term__dim');
function table(head, rows) {
  const widths = head.map((c, i) => Math.max(String(c).length, ...rows.map(r => String(r[i]).length)));
  const fmtRow = r => r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  const pre = h('pre', { class: 'term__table' }, [fmtRow(head), widths.map(w => '─'.repeat(w)).join('  '), ...rows.map(fmtRow)].join('\n'));
  out.appendChild(pre); out.scrollTop = out.scrollHeight;
}
function chart(title, x, series, { log = false } = {}) {
  $('#term-chart-h').textContent = title;
  state.lastChart = () => makeChart($('#term-chart'), (t, width) => ({
    ...chartBase(t),
    grid: { left: 60, right: 12, top: width < 600 ? 64 : 36, bottom: 32 },
    legend: { top: 0, left: 0, textStyle: { color: t.ink2 } },
    tooltip: { ...tooltipBase(t), trigger: 'axis', valueFormatter: v => fmt(v, 'num', 2) },
    xAxis: { type: 'category', data: x, ...axisStyle(t, { splitLine: { show: false } }) },
    yAxis: { type: log ? 'log' : 'value', scale: true, ...axisStyle(t) },
    series: series.map((s, i) => ({ name: s.name, type: s.type || 'line', data: s.data, showSymbol: false, lineStyle: { color: t.series[i % 7], width: 1.6, type: i % 2 ? 'dashed' : 'solid' }, itemStyle: { color: t.series[i % 7] } })),
  }));
  state.lastChart();
}

// ---------------------------------------------------------------- data
async function ensureShowdownData() {
  if (state.showdownDs) return;
  let ds = null;
  try { ds = await fetchLocalDataset(); } catch { ds = null; }
  state.showdownDs = ds || makeSyntheticDataset(7);
  state.dsLabel = ds ? 'your local French data' : 'SYNTHETIC data (random numbers)';
  if (!state.market) state.market = ds ? fromFrench(ds) : fromSynthetic();
}
const ids = () => STRATEGIES.map(s => s.id);

// ---------------------------------------------------------------- commands
const COMMANDS = {
  help: {
    usage: 'help [command]', about: 'List commands, or explain one.',
    run(args) {
      if (args[0] && COMMANDS[args[0]]) { const c = COMMANDS[args[0]]; ok(c.usage); line(c.about); if (c.more) dim(c.more); return; }
      table(['command', 'what it does'], Object.entries(COMMANDS).map(([k, c]) => [c.usage, c.about]));
      dim('Strategy ids: ' + ids().join(', '));
    },
  },
  data: {
    usage: 'data [synthetic|french|shiller]', about: 'Show or switch the market series used by models, timing and stats.',
    more: 'The Showdown commands (run, compare, pbo) always use your local French copy if present, otherwise synthetic data.',
    async run(args) {
      await ensureShowdownData();
      if (!args[0]) { ok(`Market series: ${state.market.title}`); for (const c of state.market.caveats) dim('· ' + c); ok(`Showdown dataset: ${state.dsLabel}`); return; }
      if (args[0] === 'synthetic') state.market = fromSynthetic();
      else if (args[0] === 'french') { const ds = await fetchLocalDataset().catch(() => null); if (!ds) return err('No local French copy. Run python scripts/fetch_french.py, or use the desktop app’s Data menu.'); state.market = fromFrench(ds); }
      else if (args[0] === 'shiller') { dim('Loading Shiller data (local copy, else pinned GitHub file with SHA-256 check)…'); const r = await loadShiller(); state.market = fromShiller(r.data, r.source); }
      else return err('Unknown source. Use synthetic, french or shiller.');
      ok(`Market series: ${state.market.title}`);
    },
  },
  list: {
    usage: 'list', about: 'List the strategies you can run, with their evidence label.',
    run() { table(['id', 'name', 'family', 'evidence'], STRATEGIES.map(s => [s.id, s.name, s.family, s.evidence])); },
  },
  card: {
    usage: 'card <id>', about: 'Summary, defaults, deviations and sources of one strategy.',
    async run(args) {
      const s = STRATEGIES.find(x => x.id === args[0]); if (!s) return err('Unknown id. Try: list');
      ok(s.name); line(s.summary);
      const p = defaultParams(s); if (Object.keys(p).length) dim('defaults: ' + Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', '));
      for (const d of s.deviations) warn('differs from the paper: ' + d);
      const c = await loadCitations().catch(() => new Map());
      for (const src of s.sources) { const r = c.get(src.key); dim(`source: ${r ? `${r.authors[0].family} (${r.year}), ${r.journal || ''}` : src.key} — ${src.where}`); }
      dim(`Full card: strategies.html#${s.id}`);
    },
  },
  run: {
    usage: 'run <id> [id…] [costs=naive|realistic] [from=YYYY-MM] [to=YYYY-MM] [id.param=value]', about: 'Backtest strategies side by side under identical conditions.',
    more: 'Example: run buy-hold-market faber-sma tsmom xs-momentum costs=realistic faber-sma.L=12',
    async run(args) {
      await ensureShowdownData();
      const opts = Object.fromEntries(args.filter(a => a.includes('=') && !a.includes('.')).map(a => a.split('=')));
      const overrides = args.filter(a => /^[\w-]+\.\w+=/.test(a)).map(a => { const [lhs, v] = a.split('='); const [id, k] = lhs.split('.'); return { id, k, v: Number(v) }; });
      const list = args.filter(a => !a.includes('='));
      if (!list.length) return err('Name at least one strategy id. Try: list');
      for (const id of list) if (!ids().includes(id)) return err(`Unknown id: ${id}`);
      const specs = list.map(id => ({ id, params: { ...defaultParams(getStrategy(id)), ...Object.fromEntries(overrides.filter(o => o.id === id).map(o => [o.k, o.v])) } }));
      const costs = COST_PRESETS[opts.costs || 'realistic'];
      if (!costs) return err('costs must be naive or realistic');
      const r = compare(state.showdownDs, specs, { costs, start: opts.from, end: opts.to });
      ok(`${r.conditions.evalStart} to ${r.conditions.evalEnd} · ${r.runs[0].dates.length} months · conditions ${r.conditions.hash.slice(0, 8)} · ${state.dsLabel} · HYPOTHETICAL`);
      table(['strategy', 'CAGR', 'vol', 'Sharpe', '95% CI', 'max DD', 'turnover/yr', 'p vs bench'], r.runs.map((x, i) => {
        const m = x.metrics;
        return [x.id, fmt(m.cagr, 'pct', 1), fmt(m.annVol, 'pct', 1), fmt(m.sharpe, 'num', 2), `${fmt(m.sharpeCI[0], 'num', 2)}…${fmt(m.sharpeCI[1], 'num', 2)}`, fmt(m.maxDrawdown, 'pct', 0), fmt(m.annTurnover, 'num', 1), r.tests[i] ? fmt(r.tests[i].pValue, 'p') : 'bench'];
      }));
      dim(`Benchmark for p-values: ${r.benchmark}. Overlapping intervals mean the data cannot tell the strategies apart.`);
      chart('Growth of $1 (log scale)', r.runs[0].dates, r.runs.map(x => { let w = 1; return { name: x.id, data: x.net.map(v => (w *= 1 + v)) }; }), { log: true });
    },
  },
  compare: {
    usage: 'compare <id> <id>', about: 'Is the Sharpe-ratio difference between two strategies statistically meaningful?',
    async run(args) {
      if (args.length !== 2) return err('Usage: compare <id> <id>');
      await ensureShowdownData();
      const r = compare(state.showdownDs, args.map(id => ({ id, params: defaultParams(getStrategy(id)) })), { costs: COST_PRESETS.realistic, benchmarkId: args[0] });
      const t = r.tests[1];
      ok(`${args[1]} vs ${args[0]}: Sharpe difference ${fmt(t.delta * ANN, 'num', 2)} (annualized), z = ${fmt(t.z, 'num', 2)}, p = ${fmt(t.pValue, 'p')}`);
      line(t.pValue < 0.05 ? 'Unlikely to be chance alone at the 5% level (before counting how many comparisons you have tried).' : 'Not distinguishable from chance at the 5% level.');
      dim('Delta-method test with HAC errors (Ledoit & Wolf 2008 alternative); see metrics.html.');
    },
  },
  stats: {
    usage: 'stats', about: 'Stylized facts of the current market series.',
    async run() {
      await ensureShowdownData();
      const x = state.market.ret.map(r => Math.log(1 + r));
      const f = stylizedFacts(x);
      ok(state.market.title);
      table(['fact', 'value'], FACTS.map(k => [k.label, k.fmt === 'num' ? fmt(f[k.id], 'num', 2) : fmt(f[k.id], 'pct', k.fmt === 'pct2' ? 2 : 1)]));
    },
  },
  models: {
    usage: 'models [sims]', about: 'Fit six return models and check which stylized facts each reproduces.',
    async run(args) {
      await ensureShowdownData();
      const x = state.market.ret.map(r => Math.log(1 + r));
      const nSims = Math.min(500, Math.max(20, Number(args[0]) || 100));
      dim(`Fitting on ${x.length} months, ${nSims} simulations each…`);
      await new Promise(r => setTimeout(r, 0));
      const fits = fitAll(x);
      const c = compareFacts(x, fits, { nSims });
      const mark = v => (v === 'inside' ? '✓' : v === 'above' ? '↑' : '↓');
      table(['fact', 'real', ...MODEL_IDS.map(id => MODELS[id].short)], FACTS.map(f => [f.id, fmt(c.real[f.id], 'num', 2), ...MODEL_IDS.map(id => mark(c.models[id].bands[f.id].verdict))]));
      table(['model', 'AIC', 'BIC', 'facts ✓'], MODEL_IDS.map(id => [MODELS[id].short, fmt(fits[id].aic, 'num', 0), fmt(fits[id].bic, 'num', 0), `${c.models[id].reproduced}/${FACTS.length}`]));
      dim('✓ inside the 5–95% range of simulated histories; ↑/↓ real value above/below it. Details: markets.html');
    },
  },
  timing: {
    usage: 'timing [accuracy]', about: 'Simulate timers who call each month right with the given accuracy (default 0.6).',
    async run(args) {
      await ensureShowdownData();
      const p = Number(args[0] ?? 0.6);
      if (!(p >= 0 && p <= 1)) return err('Accuracy must be between 0 and 1.');
      const { ret, cash } = state.market;
      const r = T.skillTimers(ret, cash, { p, nSims: 1000, costBps: 10 });
      const be = T.breakEvenAccuracy(ret, cash, { nSims: 150, costBps: 10 });
      ok(`${fmt(r.shareBeatingBuyHold * 100, 'num', 0)}% of 1,000 timers with ${fmt(p * 100, 'num', 0)}% monthly accuracy beat buy-and-hold (10 bps per switch).`);
      line(`Accuracy needed for half of them to win: ${be.breakEven ? fmt(be.breakEven * 100, 'num', 0) + '%' : 'more than 100%'}.`);
      chart('Share of timers beating buy-and-hold vs accuracy', be.curve.map(c => fmt(c.p * 100, 'num', 0) + '%'), [{ name: 'share beating buy-and-hold', data: be.curve.map(c => c.share) }]);
    },
  },
  miss: {
    usage: 'miss', about: 'Final wealth after missing the best or worst months (perfect hindsight).',
    async run() {
      await ensureShowdownData();
      const m = T.missingMonths(state.market.ret, state.market.cash, [0, 1, 5, 10, 20]);
      table(['months missed', 'missed best', 'missed worst', 'missed both'], m.map(x => [x.n, '$' + fmt(x.missBest, 'num', 1), '$' + fmt(x.missWorst, 'num', 1), '$' + fmt(x.missBoth, 'num', 1)]));
      dim(`Best and worst months cluster: ${fmt(T.bestNearWorst(state.market.ret, state.market.cash) * 100, 'num', 0)}% of the 20 best were within 6 months of one of the 20 worst.`);
    },
  },
  pbo: {
    usage: 'pbo <faber|tsmom|xsmom|pairs> [S]', about: 'Probability of backtest overfitting for a parameter sweep.',
    async run(args) {
      await ensureShowdownData();
      const sets = {
        faber: ['faber-sma', Array.from({ length: 23 }, (_, i) => ({ L: i + 2 }))],
        tsmom: ['tsmom', Array.from({ length: 24 }, (_, i) => ({ lookback: i + 1 }))],
        xsmom: ['xs-momentum', Array.from({ length: 12 }, (_, i) => i + 1).flatMap(J => [1, 3, 6, 9, 12].map(K => ({ J, K })))],
        pairs: ['ggr-pairs', [6, 12, 24].flatMap(F => [0.5, 1, 1.5, 2, 2.5, 3].map(k => ({ F, k })))],
      }[args[0]];
      if (!sets) return err('Choose one of: faber, tsmom, xsmom, pairs');
      const S = Number(args[1] || 16);
      const sw = sweep(state.showdownDs, sets[0], sets[1], { costs: COST_PRESETS.realistic });
      const r = cscv(sw.columns, { S });
      ok(`${sets[1].length} settings · ${r.combinations} splits · PBO ${fmt(r.pbo * 100, 'num', 0)}% · probability of loss ${fmt(r.probLoss * 100, 'num', 0)}%`);
      dim('PBO near 50% means picking the in-sample best is about as good as picking at random. Details: overfitting.html');
    },
  },
  atlas: {
    usage: 'atlas [family]', about: 'List algorithm families, or the algorithms in one.',
    run(args) {
      if (!args[0]) { table(['family', 'entries'], FAMILIES.map(f => [f.id, ATLAS.filter(a => a.family === f.id).length])); return; }
      const list = ATLAS.filter(a => a.family === args[0]);
      if (!list.length) return err('Unknown family. Try: atlas');
      table(['algorithm', 'where it runs'], list.map(a => [a.name, a.status]));
    },
  },
  cite: {
    usage: 'cite <key>', about: 'Print a full reference (keys appear in card output).',
    async run(args) {
      const c = await loadCitations(); const r = c.get(args[0]);
      if (!r) return err('Unknown key.');
      line(`${r.authors.map(a => `${a.family}, ${a.given || ''}`.trim()).join('; ')} (${r.year ?? 'n.d.'}). ${r.title}. ${r.journal || ''} ${r.volume || ''}${r.issue ? `(${r.issue})` : ''}${r.pages ? `: ${r.pages}` : ''}.`);
      dim(r.doi ? `doi:${r.doi} · verified: ${r.verification}` : `${r.url} · verified: ${r.verification}`);
    },
  },
  oss: {
    usage: 'oss [category]', about: 'Open-source terminals, backtesters and tools, with licences.',
    async run(args) {
      const d = await fetch('data/open-source.json', { credentials: 'same-origin' }).then(r => r.json());
      const list = d.tools.filter(t => t.repo && (!args[0] || t.category.startsWith(args[0])));
      table(['project', 'category', 'licence'], list.map(t => [t.name, t.category, t.license.length > 28 ? t.license.slice(0, 27) + '…' : t.license]));
      dim(`Licences read ${d.checked}. Full table: open-source.html`);
    },
  },
  clear: { usage: 'clear', about: 'Clear the screen (or press Ctrl+L).', run() { clear(out); } },
  history: { usage: 'history', about: 'Show previous commands.', run() { state.history.forEach((c, i) => dim(`${i + 1}  ${c}`)); } },
};

async function exec(raw) {
  const text = raw.trim();
  if (!text) return;
  line(`showdown> ${text}`, 'term__cmd');
  state.history.push(text); state.hIdx = state.history.length;
  const [cmd, ...args] = text.split(/\s+/);
  const c = COMMANDS[cmd.toLowerCase()];
  if (!c) return err(`Unknown command “${cmd}”. Type help.`);
  try { await c.run(args); } catch (e) { err(e.message); }
}

function complete() {
  const v = input.value;
  const parts = v.split(/\s+/);
  const last = parts[parts.length - 1];
  const pool = parts.length === 1 ? Object.keys(COMMANDS) : [...ids(), 'synthetic', 'french', 'shiller', 'costs=naive', 'costs=realistic', 'faber', 'tsmom', 'xsmom', 'pairs', ...FAMILIES.map(f => f.id)];
  const hits = pool.filter(p => p.startsWith(last));
  if (hits.length === 1) { parts[parts.length - 1] = hits[0]; input.value = parts.join(' ') + ' '; }
  else if (hits.length > 1) dim(hits.join('  '));
}

$('#term-form').addEventListener('submit', e => { e.preventDefault(); const v = input.value; input.value = ''; exec(v); });
input.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp') { e.preventDefault(); if (state.hIdx > 0) input.value = state.history[--state.hIdx]; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); state.hIdx = Math.min(state.history.length, state.hIdx + 1); input.value = state.history[state.hIdx] || ''; }
  else if (e.key === 'Tab') { e.preventDefault(); complete(); }
  else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clear(out); }
});
document.addEventListener('keydown', e => { if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); input.focus(); } });

(async () => {
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  ok('Strategy Showdown terminal. Educational, hypothetical results; not investment advice.');
  dim('Try: help · list · run buy-hold-market faber-sma tsmom · models · timing 0.6 · pbo faber · oss');
  await ensureShowdownData();
  dim(`Showdown dataset: ${state.dsLabel}. Market series: ${state.market.title}.`);
  input.focus();
})();
