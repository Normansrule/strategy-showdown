// Showdown page: data loading, strategy picker, conditions, worker orchestration, results.
import { STRATEGIES, defaultParams } from '../../engine/strategies/index.js';
import { COST_PRESETS } from '../../engine/runner.js';
import { METRIC_INFO } from '../../engine/metrics.js';
import { fetchLocalDataset, loadFrenchFiles, makeSyntheticDataset, FRENCH_FILES } from '../../engine/data/loaders.js';
import {
  $, $$, h, clear, fmt, monthLabel, initPage, tokens, SERIES_STYLE, lineKey, helpButton, loadCitations, authorsShort,
  makeChart, chartBase, axisStyle, tooltipBase, tooltipDom, tableToggle, debounce, currentTheme,
} from './common.js';

initPage();

const DEFAULT_ON = new Set(['buy-hold-market', 'equal-weight', 'faber-sma', 'tsmom', 'xs-momentum']);
const SHORT = {
  'buy-hold-market': 'Market', 'equal-weight': '1/N', 'faber-sma': 'SMA timing', tsmom: 'TSMOM',
  'xs-momentum': 'XS momentum', 'st-reversal': 'ST reversal', 'mean-variance': 'Mean-variance',
};
const EVIDENCE_LABEL = {
  'published-replicable': 'Published, replicable',
  'published-data-restricted': 'Published, data restricted',
  'public-description': 'Public description only',
  definition: 'Definition',
};
const slotOf = id => STRATEGIES.findIndex(s => s.id === id) % SERIES_STYLE.length;
const styleOf = id => SERIES_STYLE[slotOf(id)];

// ---------------- State ----------------
const state = {
  raw: null,           // dataset object as loaded
  source: null,        // 'local' | 'files' | 'synthetic'
  info: null,          // from worker: fingerprint, range
  localAvailable: false,
  picks: Object.fromEntries(STRATEGIES.map(s => [s.id, { on: DEFAULT_ON.has(s.id), params: defaultParams(s) }])),
  costMode: 'realistic',
  tradeCostBps: COST_PRESETS.realistic.tradeCostBps,
  borrowBpsPerYear: COST_PRESETS.realistic.borrowBpsPerYear,
  start: '', end: '',
  benchmarkId: 'buy-hold-market',
  trials: {},
  result: null,
  showAlt: false,
  exposureId: 'tsmom',
  droppedFiles: [],
};

let citations = new Map();
loadCitations().then(m => { citations = m; }).catch(() => {});

// ---------------- Worker ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let msgId = 0, latestRunId = 0;
const pending = new Map();
worker.onmessage = ev => {
  const m = ev.data;
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.type === 'error' ? p.reject(Object.assign(new Error(m.message), { details: m.details })) : p.resolve(m); }
};
worker.onerror = e => { setStatus('error', 'The calculation worker failed to start: ' + (e.message || 'unknown error')); };
const ask = payload => new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); worker.postMessage({ ...payload, id }); return id; });

// ---------------- Status ----------------
function setStatus(kind, text) {
  $('#status').dataset.state = kind;
  $('#status-text').textContent = text;
}

// ---------------- Data panel ----------------
const trialStoreKey = fp => 'ss-trials:' + fp;
function loadTrials(fp) {
  try { return JSON.parse(sessionStorage.getItem(trialStoreKey(fp)) || '{}') || {}; } catch { return {}; }
}
function saveTrials(fp, trials) {
  try { sessionStorage.setItem(trialStoreKey(fp), JSON.stringify(trials)); } catch { /* storage blocked */ }
}

async function useDataset(raw, source) {
  $('#data-error').textContent = '';
  setStatus('running', 'Checking the dataset…');
  const res = await ask({ type: 'dataset', dataset: raw });
  state.raw = raw; state.source = source; state.info = res.info;
  state.trials = loadTrials(res.info.fingerprint);
  // Clamp the requested window to the new dataset.
  const { first, last } = res.info;
  for (const id of ['start', 'end']) { const el = $('#' + id); el.min = first; el.max = last; }
  if (!state.start || state.start < first || state.start > last) state.start = '';
  if (!state.end || state.end > last || state.end < first) state.end = '';
  $('#start').value = state.start || first;
  $('#end').value = state.end || last;
  renderDatasetCard();
  $('#synthetic-banner').hidden = !raw.synthetic;
  $$('.chip--hyp').forEach(c => { c.textContent = raw.synthetic ? 'Hypothetical · synthetic data' : (c.closest('.conditions-tag') ? 'Hypothetical' : 'Hypothetical backtest'); });
  $('#use-local').hidden = !(state.localAvailable && source !== 'local');
  updateTrialCount();
  run();
}

function renderDatasetCard() {
  const card = clear($('#dataset-card'));
  const raw = state.raw, info = state.info, prov = raw.provenance || {};
  const sourceLabel = { local: location.protocol === 'app:' ? 'Downloaded with the desktop app (Data menu), stored on this computer' : 'Local file (docs/data/local/french.json)', files: 'Files you added (parsed in this browser)', synthetic: 'Generated in this browser' }[state.source];
  card.appendChild(h('h3', {}, raw.title || raw.id || 'Dataset'));
  if (raw.synthetic) card.appendChild(h('p', { class: 'small' }, h('span', { class: 'chip chip--hyp' }, 'Synthetic: not market data')));
  const dl = h('dl', {},
    h('dt', {}, 'Months'), h('dd', {}, `${monthLabel(info.first)} to ${monthLabel(info.last)} (${fmt(info.months, 'int')} months)`),
    h('dt', {}, 'Assets'), h('dd', {}, `Market + ${info.assetNames.length}: ${info.assetNames.join(', ')}`),
    h('dt', {}, 'Factors'), h('dd', {}, info.factors.length ? info.factors.join(', ') : 'none (no factor attribution)'),
    h('dt', {}, 'Fingerprint'), h('dd', { title: info.fingerprint }, h('span', { class: 'num' }, info.fingerprint.slice(0, 12)), ' (SHA-256 of the data)'),
    h('dt', {}, 'Loaded from'), h('dd', {}, sourceLabel),
  );
  card.appendChild(dl);
  const det = h('details', {}, h('summary', {}, 'Provenance and caveats'));
  const items = [];
  if (prov.origin) items.push(['Origin', prov.origin]);
  if (prov.via) items.push(['Via', prov.via]);
  if (prov.vintage) items.push(['Vintage', prov.vintage]);
  if (prov.vintageNote) items.push(['Vintage', prov.vintageNote]);
  if (prov.model) items.push(['Model', prov.model]);
  if (prov.note) items.push(['Note', prov.note]);
  if (prov.market) items.push(['Market', prov.market]);
  if (prov.alignment) items.push(['Alignment', `kept ${prov.alignment.keptMonths} of ${prov.alignment.commonMonths} common months (${prov.alignment.first} to ${prov.alignment.last})`]);
  if (prov.files) for (const f of prov.files) items.push(['File', `${f.name}${f.entry && f.entry !== f.name ? ' / ' + f.entry : ''}${f.crspVintage ? ', CRSP ' + f.crspVintage : ''}, sha256 ${String(f.sha256).slice(0, 12)}`]);
  for (const c of prov.caveats || []) items.push(['Caveat', c]);
  if (prov.attribution) items.push(['Attribution', prov.attribution]);
  det.appendChild(h('ul', {}, items.map(([k, v]) => h('li', {}, h('b', {}, k + ': '), v))));
  card.appendChild(det);
  const rep = raw.replication;
  if (rep && rep.available) {
    card.appendChild(h('div', { class: 'replication', role: 'status' },
      h('b', {}, 'Replication check: momentum factor rebuilt'),
      h('span', {}, `${rep.formula || 'Mom rebuilt from the 6 size/momentum portfolios'} vs the published Mom series, ${fmt(rep.months, 'int')} months.`),
      h('span', { class: 'num' }, `Largest monthly difference ${fmt(rep.maxAbsDiff * 1e4, 'num', 2)} bps (0.01% = 1 bp) · correlation ${fmt(rep.correlation, 'num', 5)}`),
      rep.roundingNote ? h('span', { class: 'muted' }, rep.roundingNote) : null));
  } else if (rep && rep.reason && state.source === 'files') {
    card.appendChild(h('p', { class: 'small muted' }, 'Replication check not run: ' + rep.reason));
  }
}

const normName = s => s.toLowerCase().replace(/\.(zip|csv|txt)$/g, '').replace(/_csv$/, '').replace(/[^a-z0-9]/g, '');
function fileMatches(spec, name) {
  const a = normName(spec.name), b = normName(name);
  if (/industryportfolios/.test(a)) return /\d+industryportfolios/.test(b);
  return a === b;
}
function renderFileChecklist() {
  const ul = clear($('#french-files'));
  for (const f of FRENCH_FILES) {
    const have = state.droppedFiles.some(d => fileMatches(f, d.name));
    ul.appendChild(h('li', { dataset: { have: String(have) } },
      h('span', { class: 'tick', 'aria-hidden': 'true' }, have ? '✓' : ''),
      h('span', {},
        h('a', { href: f.url, rel: 'noopener noreferrer' }, f.name),
        h('span', { class: 'req' }, f.required ? 'required' : 'optional'),
        have ? h('span', { class: 'visually-hidden' }, ' (added)') : null,
        h('br'), h('span', { class: 'muted' }, f.purpose))));
  }
}

async function addFiles(fileList) {
  const errBox = $('#data-error');
  errBox.textContent = '';
  for (const f of fileList) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    state.droppedFiles = state.droppedFiles.filter(d => d.name !== f.name);
    state.droppedFiles.push({ name: f.name, bytes });
  }
  renderFileChecklist();
  $('#clear-files').hidden = state.droppedFiles.length === 0;
  const missing = FRENCH_FILES.filter(f => f.required && !state.droppedFiles.some(d => fileMatches(f, d.name)));
  if (missing.length) {
    errBox.textContent = `Still needed: ${missing.map(m => m.name).join(', ')}.`;
    return;
  }
  try {
    setStatus('running', 'Reading your files…');
    const ds = await loadFrenchFiles(state.droppedFiles.map(d => ({ name: d.name, bytes: d.bytes })));
    await useDataset(ds, 'files');
  } catch (err) {
    errBox.textContent = err.message + ' Use “Remove added files” to start over.';
    setStatus('error', 'Could not read the files.');
  }
}

function initDataPanel() {
  renderFileChecklist();
  $('#clear-files').addEventListener('click', () => { state.droppedFiles = []; $('#data-error').textContent = ''; $('#clear-files').hidden = true; renderFileChecklist(); });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.dataset.over = 'true'; });
  dz.addEventListener('dragleave', () => { dz.dataset.over = 'false'; });
  dz.addEventListener('drop', e => { e.preventDefault(); dz.dataset.over = 'false'; if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
  $('#file-input').addEventListener('change', e => { if (e.target.files.length) addFiles([...e.target.files]); e.target.value = ''; });
  $('#use-synthetic').addEventListener('click', () => useDataset(makeSyntheticDataset(7), 'synthetic'));
  $('#use-local').addEventListener('click', async () => {
    const ds = await fetchLocalDataset().catch(() => null);
    if (ds) useDataset(ds, 'local');
  });
}

// ---------------- Strategy picker ----------------
function renderPicker() {
  const list = clear($('#strategy-list'));
  for (const s of STRATEGIES) {
    const pick = state.picks[s.id];
    const st = styleOf(s.id);
    const cbId = 'pick-' + s.id;
    const body = h('div', { class: 'pick__body', id: cbId + '-body' });
    const paramsBox = h('div', { class: 'pick__params' });
    for (const [key, spec] of Object.entries(s.params)) {
      const inputId = `${cbId}-${key}`;
      const hintId = inputId + '-src';
      const input = h('input', {
        type: 'number', id: inputId, min: spec.min, max: spec.max, step: spec.step, value: pick.params[key],
        inputmode: 'decimal', 'aria-describedby': hintId, required: true,
      });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (input.value === '' || !Number.isFinite(v) || v < spec.min || v > spec.max) { input.setCustomValidity(`Between ${spec.min} and ${spec.max}`); return; }
        input.setCustomValidity('');
        pick.params[key] = v;
        scheduleRun();
      });
      paramsBox.appendChild(h('div', { class: 'field' },
        h('label', { for: inputId }, spec.label),
        input,
        h('span', { class: 'field__hint', id: hintId }, `${spec.min} to ${spec.max}. Source: ${spec.source}`)));
    }
    if (Object.keys(s.params).length) body.appendChild(paramsBox);
    else body.appendChild(h('p', { class: 'small muted' }, 'No parameters: this rule is fully defined.'));
    const presets = [{ label: 'Published defaults', values: defaultParams(s) }, ...(s.presets || [])];
    if (Object.keys(s.params).length) {
      body.appendChild(h('div', { class: 'pick__presets' }, h('span', { class: 'muted' }, 'Presets:'),
        presets.map(p => h('button', {
          type: 'button', class: 'btn', onclick: () => {
            Object.assign(pick.params, p.values);
            for (const [k, v] of Object.entries(p.values)) { const inp = $(`#${cbId}-${k}`); if (inp) { inp.value = v; inp.setCustomValidity(''); } }
            scheduleRun();
          },
        }, p.label))));
    }
    body.appendChild(h('div', { class: 'pick__links' }, h('a', { href: `strategies.html#${s.id}` }, 'Strategy card: equations, sources, how ours differs')));

    const cb = h('input', { type: 'checkbox', id: cbId, 'aria-controls': cbId + '-body' });
    cb.checked = pick.on;
    const card = h('div', { class: 'pick', dataset: { on: String(pick.on), slot: String(st.slot) } },
      h('div', { class: 'pick__head' },
        cb,
        h('div', {},
          h('label', { class: 'pick__title', for: cbId }, lineKey(st.slot, st.dash), s.name),
          h('div', { class: 'pick__chips' },
            h('span', { class: 'chip chip--family' }, s.family),
            h('span', { class: `chip chip--evidence chip--ev-${s.evidence}`, title: 'Evidence label: see the Sources page' }, EVIDENCE_LABEL[s.evidence] || s.evidence)),
          h('p', { class: 'pick__summary' }, s.summary))),
      body);
    cb.addEventListener('change', () => {
      pick.on = cb.checked;
      card.dataset.on = String(pick.on);
      renderBenchmarkSelect();
      scheduleRun();
    });
    list.appendChild(card);
  }
}

function selectedSpecs() {
  return STRATEGIES.filter(s => state.picks[s.id].on).map(s => ({ id: s.id, params: { ...state.picks[s.id].params } }));
}

function renderBenchmarkSelect() {
  const sel = clear($('#benchmark'));
  const specs = selectedSpecs();
  if (!specs.some(s => s.id === state.benchmarkId)) state.benchmarkId = specs[0]?.id || 'buy-hold-market';
  for (const s of specs) {
    const o = h('option', { value: s.id }, STRATEGIES.find(x => x.id === s.id).name);
    if (s.id === state.benchmarkId) o.selected = true;
    sel.appendChild(o);
  }
}

// ---------------- Conditions ----------------
function currentCosts() {
  return { mode: state.costMode, tradeCostBps: state.tradeCostBps, borrowBpsPerYear: state.borrowBpsPerYear };
}
function syncCostButtons() {
  $$('[data-cost]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.cost === state.costMode));
    if (b.dataset.cost === 'custom') b.hidden = state.costMode !== 'custom';
  });
  $('#trade-cost').value = state.tradeCostBps;
  $('#borrow-cost').value = state.borrowBpsPerYear;
  $('#eq-alt-toggle').textContent = state.costMode === 'naive' ? 'Overlay realistic costs' : 'Overlay zero costs';
}
function initConditions() {
  $$('[data-cost]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.cost === 'custom') return;
    const p = COST_PRESETS[b.dataset.cost];
    state.costMode = p.mode; state.tradeCostBps = p.tradeCostBps; state.borrowBpsPerYear = p.borrowBpsPerYear;
    syncCostButtons(); scheduleRun();
  }));
  const onCostInput = () => {
    const tc = Number($('#trade-cost').value), bc = Number($('#borrow-cost').value);
    if (!(tc >= 0 && tc <= 500) || !(bc >= 0 && bc <= 2000)) return;
    state.tradeCostBps = tc; state.borrowBpsPerYear = bc;
    const match = Object.values(COST_PRESETS).find(p => p.tradeCostBps === tc && p.borrowBpsPerYear === bc);
    state.costMode = match ? match.mode : 'custom';
    syncCostButtons(); scheduleRun();
  };
  $('#trade-cost').addEventListener('input', onCostInput);
  $('#borrow-cost').addEventListener('input', onCostInput);
  const onDate = () => {
    const s = $('#start').value, e = $('#end').value;
    if (!state.info) return;
    state.start = s && s !== state.info.first ? s : '';
    state.end = e && e !== state.info.last ? e : '';
    scheduleRun();
  };
  $('#start').addEventListener('change', onDate);
  $('#end').addEventListener('change', onDate);
  $('#benchmark').addEventListener('change', e => { state.benchmarkId = e.target.value; scheduleRun(); });
  $('#reset-trials').addEventListener('click', () => {
    state.trials = {};
    if (state.info) saveTrials(state.info.fingerprint, {});
    updateTrialCount();
    scheduleRun();
  });
  $('#eq-alt-toggle').addEventListener('click', () => {
    state.showAlt = !state.showAlt;
    $('#eq-alt-toggle').setAttribute('aria-pressed', String(state.showAlt));
    if (state.result) renderEquity(state.result);
  });
  $('#exp-select').addEventListener('change', e => { state.exposureId = e.target.value; if (state.result) renderExposure(state.result); });
  syncCostButtons();
}
function updateTrialCount() {
  $('#trial-count').textContent = fmt(Object.keys(state.trials).length, 'int');
}

// ---------------- Running ----------------
const scheduleRun = debounce(() => run(), 350);
async function run() {
  if (!state.info) return;
  const specs = selectedSpecs();
  const errBox = $('#run-error');
  if (!specs.length) { errBox.textContent = 'Pick at least one strategy in step 2.'; return; }
  const invalid = $$('#strategy-list input[type=number]').find(i => !i.checkValidity());
  if (invalid) { errBox.textContent = `Fix the highlighted parameter first (${invalid.labels?.[0]?.textContent || invalid.id}).`; return; }
  const costs = currentCosts();
  const altCosts = costs.tradeCostBps === 0 && costs.borrowBpsPerYear === 0 ? COST_PRESETS.realistic : COST_PRESETS.naive;
  const options = { costs, benchmarkId: state.benchmarkId };
  if (state.start) options.start = state.start;
  if (state.end) options.end = state.end;
  const myRun = ++latestRunId;
  $('#results-body').classList.add('is-stale');
  setStatus('running', 'Running on identical conditions…');
  try {
    const res = await ask({ type: 'run', specs, options, altCosts, trials: state.trials });
    if (myRun !== latestRunId) return;
    errBox.textContent = '';
    state.trials = res.trials;
    saveTrials(state.info.fingerprint, state.trials);
    updateTrialCount();
    state.result = res.result;
    $('#results-body').hidden = false;
    renderResults(res.result);
    const r = res.result;
    setStatus('idle', `Updated · ${r.runs.length} ${r.runs.length === 1 ? 'strategy' : 'strategies'} · ${fmt(r.runs[0].dates.length, 'int')} months · ${fmt(r.elapsedMs / 1000, 'num', 1)} s`);
  } catch (err) {
    if (myRun !== latestRunId) return;
    const hint = /shorter than 12 months/.test(err.message) ? ' Choose an earlier start month, or turn off the strategy with the longest warm-up.' : '';
    errBox.textContent = err.message + hint + (err.details ? ' Differing fields: ' + err.details.map(d => `${d.run}: ${d.key}`).join('; ') : '');
    // Never leave results from a different configuration on screen.
    state.result = null;
    $('#results-body').hidden = true;
    setStatus('error', 'This configuration could not run.');
  } finally {
    if (myRun === latestRunId) $('#results-body').classList.remove('is-stale');
  }
}

// ---------------- Results ----------------
function renderResults(r) {
  renderConditions(r);
  renderMetricsTable(r);
  renderEquity(r);
  renderRank(r);
  renderDrawdown(r);
  renderRolling(r);
  renderCorr(r);
  renderAttribution(r);
  const sel = clear($('#exp-select'));
  if (!r.runs.some(x => x.id === state.exposureId)) state.exposureId = (r.runs.find(x => x.id === 'tsmom') || r.runs[r.runs.length - 1]).id;
  for (const run of r.runs) { const o = h('option', { value: run.id }, run.name); if (run.id === state.exposureId) o.selected = true; sel.appendChild(o); }
  renderExposure(r);
  renderNotes(r);
}

function costLabel(c) {
  const name = { naive: 'Naive', realistic: 'Realistic', custom: 'Custom' }[c.mode] || c.mode;
  return `${name}: ${fmt(c.tradeCostBps, 'num', c.tradeCostBps % 1 ? 1 : 0)} bps per unit turnover, ${fmt(c.borrowBpsPerYear, 'num', c.borrowBpsPerYear % 1 ? 1 : 0)} bps/yr borrow`;
}

function renderConditions(r) {
  const c = r.conditions, w = r.window;
  $('#cond-hash').textContent = c.hash.slice(0, 8);
  $('#cond-hash').title = 'Conditions hash (SHA-256): ' + c.hash;
  const months = r.runs[0].dates.length;
  let why;
  if (w.bindingWarmup && w.bindingWarmup.length) {
    const names = w.bindingWarmup.map(b => b.name).join(' and ');
    const m = w.bindingWarmup[0].months;
    why = `Starts ${c.evalStart} because ${names} ${w.bindingWarmup.length > 1 ? 'need' : 'needs'} ${m} months of history before its first decision. Every strategy waits, so none gets extra months.`;
  } else {
    why = `Starts at the month you requested; every strategy already has enough history by then.`;
  }
  const body = clear($('#cond-body'));
  const item = (k, v, whyText) => [h('div', {}, h('dt', {}, k), h('dd', {}, v, whyText ? h('span', { class: 'why' }, whyText) : null))];
  body.append(
    ...item('Evaluation window', `${monthLabel(c.evalStart)} to ${monthLabel(c.evalEnd)} · ${fmt(months, 'int')} months`, why),
    ...item('Costs (assumption)', costLabel(c.costs), 'Trading cost is charged on turnover; borrow cost on short positions.'),
    ...item('Data', `${r.dataset.synthetic ? 'SYNTHETIC · ' : ''}fingerprint ${r.dataset.fingerprint.slice(0, 12)}`, `Universe: ${c.universe.length} assets (${c.universeNote}).`),
    ...item('Trading rules', 'Monthly, at month end', 'Decisions use data through that month only and earn the next month’s return. Everyone starts in T-bills.'),
  );
}

// Metric columns shown in the scoreboard.
const PLAIN = {
  cagr: 'The steady yearly growth rate that would turn $1 into the final amount, after costs.',
  annVol: 'How much monthly returns swing around their average, scaled to a year. Higher means a bumpier ride.',
  sharpe: 'Average return above T-bills divided by volatility: reward per unit of risk. The brackets give a 95% range for the true value (Lo 2002). A wide range means the data cannot pin the number down.',
  sharpeLoAdjusted: 'The Sharpe ratio annualized with Lo’s correction for months that resemble their neighbours. Much lower than the plain Sharpe means the smoothness is partly an illusion.',
  sortino: 'Like Sharpe, but only months below the T-bill rate count as risk. This follows the R PerformanceAnalytics definition; the original Sortino & Price text is unverified here.',
  maxDrawdown: 'The worst fall from a previous high point. −100% means everything was lost.',
  annTurnover: 'How much of the portfolio is traded in a year, counting one side of each trade. 2× means the whole portfolio is replaced twice a year.',
  avgGrossExposure: 'Total position size relative to the account, counting short positions as positive. Above 1× means borrowed money (leverage).',
  breakEvenCostBps: 'The trading cost that would bring the average return down to the T-bill rate. If real costs are higher, the strategy loses after costs. Negative: it trails T-bills even before trading costs.',
  psrVsZero: 'Probability that the true Sharpe ratio is above zero, given the length of the record and how lopsided and fat-tailed the returns are.',
  deflatedSharpe: 'Like PSR, but the bar is the Sharpe ratio the luckiest of N useless strategies would show, where N counts every configuration tried this session. Below 0.95: the result cannot be told apart from the luck of trying many things.',
  test: 'Tests whether this strategy’s Sharpe ratio differs from the benchmark’s over the same months. The p-value is the chance of a difference at least this large if the two were truly equal. p ≥ 0.05 is reported as “not significant”: the data cannot tell them apart.',
};
const EXTRA_INFO = {
  deflatedSharpe: { label: 'Deflated Sharpe', long: 'Probabilistic Sharpe ratio against the expected maximum Sharpe of N unskilled trials (Bailey & López de Prado 2014)', sources: ['bailey2014deflated'] },
  test: { label: 'vs benchmark', long: 'Difference in Sharpe ratio vs the benchmark; HAC delta-method test', sources: ['ledoit2008robust', 'newey1987hac'] },
};
const COLUMNS = [
  { key: 'cagr', anchor: 'cagr' },
  { key: 'annVol', anchor: 'volatility' },
  { key: 'sharpe', anchor: 'sharpe' },
  { key: 'sharpeLoAdjusted', anchor: 'sharpe-lo' },
  { key: 'sortino', anchor: 'sortino' },
  { key: 'maxDrawdown', anchor: 'max-drawdown' },
  { key: 'annTurnover', anchor: 'turnover' },
  { key: 'avgGrossExposure', anchor: 'exposure' },
  { key: 'breakEvenCostBps', anchor: 'break-even' },
  { key: 'psrVsZero', anchor: 'psr' },
  { key: 'deflatedSharpe', anchor: 'deflated-sharpe' },
  { key: 'test', anchor: 'sharpe-difference' },
];
function infoFor(key) { return METRIC_INFO[key] || EXTRA_INFO[key]; }

function headerCell(col, r) {
  const info = infoFor(col.key);
  let label = info.label;
  if (col.key === 'test') label = `vs ${SHORT[r.runs.find(x => x.name === r.benchmark)?.id] || r.benchmark}`;
  if (col.key === 'sharpe') label = 'Sharpe [95% range]';
  const btn = helpButton(label, () => {
    const srcs = (info.sources || []).map(k => citations.get(k)).filter(Boolean);
    return [
      h('p', {}, h('b', {}, info.long)),
      h('p', {}, PLAIN[col.key] || ''),
      srcs.length ? h('p', { class: 'muted' }, 'Source: ', srcs.map((c, i) => [i ? '; ' : '', `${authorsShort(c)} (${c.year})`])) : null,
      h('a', { href: `metrics.html#${col.anchor}` }, 'Equation and worked example'),
    ];
  });
  return h('th', { scope: 'col' }, h('span', { class: 'th-help' }, label, btn));
}

function keySwatch(id) { const st = styleOf(id); return lineKey(st.slot, st.dash, { width: 22, height: 10 }); }

function renderMetricsTable(r) {
  const alerts = clear($('#ruin-alerts'));
  for (const run of r.runs.filter(x => x.ruinedAt)) {
    alerts.appendChild(h('div', { class: 'callout callout--danger', role: 'alert' },
      h('p', {}, h('span', { class: 'badge-ruin' }, 'Wiped out'), ' ',
        h('b', {}, `${run.name}: account wiped out in ${monthLabel(run.ruinedAt)}.`),
        ' A single month lost 100% or more of the money (leveraged positions). After that the account holds nothing, and its statistics include those empty months.')));
  }
  const thead = h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Strategy'), COLUMNS.map(c => headerCell(c, r))));
  const tbody = h('tbody');
  r.runs.forEach((run, i) => {
    const m = run.metrics, test = r.tests[i];
    const cells = COLUMNS.map(col => {
      const k = col.key;
      switch (k) {
        case 'sharpe': return h('td', {}, h('span', { class: 'strong' }, fmt(m.sharpe)), h('span', { class: 'sub' }, `[${fmt(m.sharpeCI[0])}, ${fmt(m.sharpeCI[1])}]`));
        case 'breakEvenCostBps': {
          if (m.breakEvenCostBps === Infinity) return h('td', {}, 'no trading');
          if (m.breakEvenCostBps < 0) return h('td', {}, fmt(m.breakEvenCostBps, 'bps'), h('span', { class: 'sub' }, 'trails T-bills before costs'));
          return h('td', {}, fmt(m.breakEvenCostBps, 'bps'));
        }
        case 'deflatedSharpe': return h('td', {}, m.deflatedSharpe === null ? '—' : fmt(m.deflatedSharpe, 'prob'), h('span', { class: 'sub' }, `N = ${m.trialsCounted}`));
        case 'test': {
          if (!test) return h('td', {}, h('span', { class: 'muted' }, 'benchmark'));
          const sig = test.pValue < 0.05;
          return h('td', {}, h('span', { class: sig ? 'sig-yes' : 'sig-no' }, `p = ${fmt(test.pValue, 'p')}`),
            h('span', { class: 'sub' }, sig ? `significant at 5% (Δ ${fmt(test.delta * Math.sqrt(12))})` : 'not significant'));
        }
        case 'annTurnover': case 'avgGrossExposure': return h('td', {}, fmt(m[k], 'x'));
        default: return h('td', {}, fmt(m[k], METRIC_INFO[k]?.fmt || 'num'));
      }
    });
    tbody.appendChild(h('tr', { class: run.ruinedAt ? 'is-ruined' : '' },
      h('th', { scope: 'row', class: 'txt' }, h('span', { class: 'series-name' }, keySwatch(run.id), run.name),
        run.ruinedAt ? h('span', { class: 'sub' }, h('span', { class: 'badge-ruin' }, `wiped out ${run.ruinedAt}`)) : null),
      cells));
  });
  const wrap = clear($('#metrics-table-wrap'));
  wrap.appendChild(h('table', { class: 'data metrics' }, h('caption', { class: 'visually-hidden' }, 'Hypothetical backtest metrics per strategy'), thead, tbody));
  $('#metrics-caption').textContent = `Sharpe-type ratios are annualized from monthly excess returns (return minus the T-bill rate). The Sharpe-difference p-values use a HAC delta-method test with ${r.tests.find(Boolean)?.lags ?? '—'} Bartlett lags; Ledoit & Wolf (2008) recommend a studentized bootstrap, which is on the roadmap. Deflated Sharpe counts ${r.runs[0].metrics.trialsCounted} configurations tried this session.`;
}

// ---------- chart helpers ----------
function legendFor(runs, extra) {
  const box = h('div', { class: 'legend-html' });
  for (const run of runs) box.appendChild(h('span', {}, keySwatch(run.id), SHORT[run.id] || run.name));
  if (extra) box.appendChild(extra);
  return box;
}
function placeLegend(chartEl, runs, extra) {
  const prev = chartEl.previousElementSibling;
  if (prev && prev.classList.contains('legend-html')) prev.remove();
  chartEl.before(legendFor(runs, extra));
}
const yearLabel = v => v.slice(0, 4);
function timeX(t, dates) {
  return { type: 'category', data: dates, boundaryGap: false, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 11, formatter: yearLabel, hideOverlap: true } };
}
function lineSeries(t, run, data, extra = {}) {
  const st = styleOf(run.id);
  return {
    name: run.name, type: 'line', data, showSymbol: false, symbol: st.symbol, symbolSize: 8,
    lineStyle: { width: 2, color: t.series[st.slot], type: st.dash || 'solid', cap: 'round', join: 'round' },
    itemStyle: { color: t.series[st.slot] }, emphasis: { disabled: true }, connectNulls: false, ...extra,
  };
}
function axisTooltip(t, metaFor, valueFmt, note) {
  return {
    ...tooltipBase(t), trigger: 'axis',
    formatter: params => {
      const list = Array.isArray(params) ? params : [params];
      if (!list.length) return '';
      const rows = list.map(p => {
        const meta = metaFor(p.seriesIndex);
        const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
        return { ...meta, value: v === null || v === undefined || v === '-' ? '—' : valueFmt(v) };
      }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return tooltipDom(monthLabel(list[0].axisValue), rows, note);
    },
  };
}
const gridFor = (width, extra = {}) => ({ left: 10, right: width < 500 ? 10 : 18, top: 14, bottom: 4, containLabel: true, ...extra });

// ---------- Equity ----------
function renderEquity(r) {
  const el = $('#chart-equity');
  const dates = r.runs[0].dates;
  const alt = r.alt;
  const altIsNaive = alt && alt.costs.tradeCostBps === 0 && alt.costs.borrowBpsPerYear === 0;
  const altNote = alt ? (altIsNaive ? 'zero costs' : 'realistic costs') : '';
  const extra = state.showAlt && alt ? h('span', { class: 'muted' }, `Faint lines: the same strategies with ${altNote}.`) : null;
  placeLegend(el, r.runs, extra);
  $('#eq-sub').textContent = `Log scale, so equal vertical distances mean equal percentage changes. Solid colours use the current cost assumptions${state.showAlt && alt ? `; faint lines show ${altNote}` : ''}. A line that stops means the account was wiped out.`;
  makeChart(el, (t, width) => {
    const series = r.runs.map(run => lineSeries(t, run, run.wealth));
    const meta = r.runs.map((run, i) => ({ name: SHORT[run.id] || run.name, slot: styleOf(run.id).slot, order: i }));
    if (state.showAlt && alt) {
      alt.runs.forEach((ar, i) => {
        const run = r.runs.find(x => x.id === ar.id);
        const s = lineSeries(t, run, ar.wealth, { name: run.name + ' (' + altNote + ')', z: 1 });
        s.lineStyle = { ...s.lineStyle, width: 1.25, opacity: 0.4 };
        series.push(s);
        meta.push({ name: `${SHORT[run.id]} (${altNote})`, slot: styleOf(run.id).slot, dashed: true, order: i + 0.5 });
      });
    }
    return {
      ...chartBase(t),
      grid: gridFor(width),
      tooltip: axisTooltip(t, i => meta[i], v => '$' + fmt(v, 'num', v < 10 ? 2 : 0)),
      xAxis: timeX(t, dates),
      yAxis: { type: 'log', logBase: 10, ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, formatter: v => '$' + (v >= 1 ? fmt(v, 'num', 0) : fmt(v, 'num', v >= 0.1 ? 1 : 2)) } },
      series,
    };
  });
  const btn = $('#eq-table-btn');
  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    tableToggle(btn, $('#eq-table'), () => seriesTable(state.result, run => run.wealth, v => '$' + fmt(v, 'num', 2), 'Growth of $1 at each December'));
  } else if (!$('#eq-table').hidden) { clear($('#eq-table')).appendChild(seriesTable(r, run => run.wealth, v => '$' + fmt(v, 'num', 2), 'Growth of $1 at each December')); }
}

function seriesTable(r, get, f, caption) {
  const dates = r.runs[0].dates;
  const idx = dates.map((d, i) => [d, i]).filter(([d], i) => d.endsWith('-12') || i === dates.length - 1);
  return h('table', { class: 'data' }, h('caption', { class: 'visually-hidden' }, caption),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Month'), r.runs.map(run => h('th', { scope: 'col' }, SHORT[run.id] || run.name)))),
    h('tbody', {}, idx.map(([d, i]) => h('tr', {}, h('th', { scope: 'row', class: 'txt' }, d), r.runs.map(run => { const v = get(run)[i]; return h('td', {}, v === null || v === undefined ? '—' : f(v)); })))));
}

// ---------- Ranking under costs (dumbbell) ----------
let measureCtx = null;
function labelWidth(labels, px, font) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${px}px ${font}`;
  return Math.ceil(Math.max(...labels.map(l => measureCtx.measureText(l).width)));
}
function renderRank(r) {
  const el = $('#chart-rank');
  const alt = r.alt;
  if (!alt) return;
  const altIsNaive = alt.costs.tradeCostBps === 0 && alt.costs.borrowBpsPerYear === 0;
  const zero = altIsNaive ? alt.runs.map(a => a.metrics.sharpe) : r.runs.map(x => x.metrics.sharpe);
  const withCost = altIsNaive ? r.runs.map(x => x.metrics.sharpe) : alt.runs.map(a => a.metrics.sharpe);
  const costC = altIsNaive ? r.conditions.costs : alt.costs;
  const costText = `${fmt(costC.tradeCostBps, 'num', 0)} bps trading, ${fmt(costC.borrowBpsPerYear, 'num', 0)} bps/yr borrow`;
  const rankOf = arr => { const order = arr.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); const rk = []; order.forEach(([, i], k) => { rk[i] = k + 1; }); return rk; };
  const rz = rankOf(zero), rc = rankOf(withCost);
  // Rows sorted by Sharpe after costs (best at top).
  const order = r.runs.map((_, i) => i).sort((a, b) => withCost[a] - withCost[b]);
  const cats = order.map(i => `${SHORT[r.runs[i].id]} (#${rz[i]} → #${rc[i]})`);
  $('#rank-sub').textContent = `Annualized Sharpe ratio with zero costs (hollow marker) and with ${costText} (filled marker), over the same months. Each row shows the rank without and with costs; rows are sorted by the result after costs.`;
  const prev = el.previousElementSibling;
  if (prev && prev.classList.contains('legend-html')) prev.remove();
  el.before(h('div', { class: 'legend-html' },
    h('span', {}, h('span', { class: 'dot-key dot-key--hollow', 'aria-hidden': 'true' }), 'Zero costs'),
    h('span', {}, h('span', { class: 'dot-key', 'aria-hidden': 'true' }), `With costs (${costText})`)));
  el.classList.toggle('chart--rows', true);
  el.dataset.rows = String(order.length);
  makeChart(el, (t, width) => ({
    ...chartBase(t),
    grid: { left: labelWidth(cats, 12, t.font) + 14, right: 92, top: 8, bottom: 24, containLabel: false },
    tooltip: {
      ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.surface2, opacity: 0.6 } },
      formatter: ps => {
        const i = order[ps[0].dataIndex];
        const slot = styleOf(r.runs[i].id).slot;
        return tooltipDom(r.runs[i].name, [
          { name: 'Zero costs', value: `${fmt(zero[i])} (rank ${rz[i]})`, slot, dashed: true },
          { name: 'With costs', value: `${fmt(withCost[i])} (rank ${rc[i]})`, slot },
        ]);
      },
    },
    yAxis: { type: 'category', data: cats, ...axisStyle(t, { splitLine: { show: false } }), axisTick: { show: false }, axisLabel: { color: t.ink2, fontSize: 12, interval: 0 } },
    xAxis: { type: 'value', scale: true, splitNumber: width < 500 ? 3 : 5, ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, hideOverlap: true } },
    series: [
      {
        type: 'custom', silent: true, z: 1,
        renderItem: (params, api) => {
          const a = api.coord([api.value(0), api.value(2)]), b = api.coord([api.value(1), api.value(2)]);
          const right = Math.max(a[0], b[0]);
          return { type: 'group', children: [
            { type: 'line', shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: { stroke: t.series[api.value(3)], lineWidth: 2, opacity: 0.55 } },
            { type: 'text', x: right + 10, y: b[1], style: { text: `${fmt(api.value(0))} \u2192 ${fmt(api.value(1))}`, fill: t.ink2, fontSize: 11, fontFamily: t.font, verticalAlign: 'middle' } },
          ] };
        },
        data: order.map((i, k) => [zero[i], withCost[i], k, styleOf(r.runs[i].id).slot]),
        encode: { x: [0, 1], y: 2 },
      },
      {
        name: 'Zero costs', type: 'scatter', z: 2, symbolSize: 11,
        data: order.map(i => ({ value: zero[i], itemStyle: { color: t.surface, borderColor: t.series[styleOf(r.runs[i].id).slot], borderWidth: 2 } })),
      },
      {
        name: 'With costs', type: 'scatter', z: 3, symbolSize: 11,
        data: order.map(i => ({ value: withCost[i], symbol: styleOf(r.runs[i].id).symbol === 'pin' ? 'circle' : styleOf(r.runs[i].id).symbol, itemStyle: { color: t.series[styleOf(r.runs[i].id).slot], borderColor: t.surface, borderWidth: 2 } })),
      },
    ],
  }));
  el.style.height = Math.max(170, 44 * order.length + 40) + 'px';
  echarts.getInstanceByDom(el)?.resize();
}

// ---------- Drawdown ----------
function renderDrawdown(r) {
  const el = $('#chart-dd');
  placeLegend(el, r.runs);
  const meta = r.runs.map((run, i) => ({ name: SHORT[run.id] || run.name, slot: styleOf(run.id).slot, order: i }));
  makeChart(el, (t, width) => ({
    ...chartBase(t), grid: gridFor(width),
    tooltip: axisTooltip(t, i => meta[i], v => fmt(v, 'pct', 1)),
    xAxis: timeX(t, r.runs[0].dates),
    yAxis: { type: 'value', max: 0, ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, formatter: v => fmt(v, 'pct', 0) } },
    series: r.runs.map(run => lineSeries(t, run, run.drawdown, { lineStyle: { width: 1.5, color: t.series[styleOf(run.id).slot], type: styleOf(run.id).dash || 'solid' } })),
  }));
  const btn = $('#dd-table-btn');
  if (!btn.dataset.bound) { btn.dataset.bound = '1'; tableToggle(btn, $('#dd-table'), () => seriesTable(state.result, run => run.drawdown, v => fmt(v, 'pct', 1), 'Drawdown at each December')); }
}

// ---------- Rolling Sharpe ----------
function renderRolling(r) {
  const el = $('#chart-roll');
  placeLegend(el, r.runs);
  const meta = r.runs.map((run, i) => ({ name: SHORT[run.id] || run.name, slot: styleOf(run.id).slot, order: i }));
  makeChart(el, (t, width) => ({
    ...chartBase(t), grid: gridFor(width),
    tooltip: axisTooltip(t, i => meta[i], v => fmt(v)),
    xAxis: timeX(t, r.runs[0].dates),
    yAxis: { type: 'value', ...axisStyle(t) },
    series: r.runs.map((run, i) => lineSeries(t, run, run.rolling, i === 0 ? {
      lineStyle: { width: 1.5, color: t.series[styleOf(run.id).slot], type: styleOf(run.id).dash || 'solid' },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: t.ink3, width: 1, type: 'solid' }, data: [{ yAxis: 0 }] },
    } : { lineStyle: { width: 1.5, color: t.series[styleOf(run.id).slot], type: styleOf(run.id).dash || 'solid' } })),
  }));
  const btn = $('#roll-table-btn');
  if (!btn.dataset.bound) { btn.dataset.bound = '1'; tableToggle(btn, $('#roll-table'), () => seriesTable(state.result, run => run.rolling, v => fmt(v), 'Rolling 36-month Sharpe at each December')); }
}

// ---------- Correlation heatmap ----------
function renderCorr(r) {
  const el = $('#chart-corr');
  const names = r.runs.map(x => SHORT[x.id] || x.name);
  const n = names.length;
  makeChart(el, (t, width) => {
    // Label ink must contrast with the cell: page ink on pale cells, white/near-black on strong ones.
    const strongInk = currentTheme() === 'dark' ? t.page : '#ffffff';
    const data = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = Number.isFinite(r.corr[i][j]) ? +r.corr[i][j].toFixed(4) : '-';
      data.push({ value: [j, n - 1 - i, v], label: { color: typeof v === 'number' && Math.abs(v) > 0.6 ? strongInk : t.ink } });
    }
    const narrow = width < 520;
    return {
      ...chartBase(t),
      grid: { left: 8, right: 12, top: 8, bottom: 44, containLabel: true },
      tooltip: { ...tooltipBase(t), trigger: 'item', formatter: p => tooltipDom(`${names[n - 1 - p.value[1]]} vs ${names[p.value[0]]}`, [{ name: 'Correlation', value: fmt(p.value[2]), slot: 0 }]) },
      xAxis: { type: 'category', data: names, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink2, fontSize: 11, interval: 0, rotate: 40 } },
      yAxis: { type: 'category', data: names.slice().reverse(), ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink2, fontSize: 11, interval: 0 } },
      visualMap: {
        min: -1, max: 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, itemHeight: narrow ? 140 : 200,
        text: ['+1', '\u22121'], textStyle: { color: t.ink2, fontSize: 11 },
        inRange: { color: t.diverging },
      },
      series: [{
        type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 2 },
        label: { show: n <= 7, fontSize: narrow ? 10 : 11, formatter: p => fmt(p.value[2]) },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
      }],
    };
  });
}

// ---------- Factor attribution ----------
function renderAttribution(r) {
  const wrap = clear($('#attr-wrap'));
  if (!r.attribution) {
    wrap.appendChild(h('p', { class: 'small muted' }, 'This dataset has no factor series, so attribution is not available.'));
    return;
  }
  const names = r.attribution[0].names;
  const tfmt = (x, d = 2) => (Math.abs(x) > 999 ? (x > 0 ? '> 999' : '< \u2212999') : fmt(x, 'num', d));
  const FACT = { MktRF: 'Market', SMB: 'Size (SMB)', HML: 'Value (HML)', Mom: 'Momentum (Mom)' };
  const thead = h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Strategy'),
    h('th', { scope: 'col' }, 'Alpha / yr', h('span', { class: 'sub' }, 't-stat')),
    names.slice(1).map(n => h('th', { scope: 'col' }, FACT[n] || n, h('span', { class: 'sub' }, 'beta (t)'))),
    h('th', { scope: 'col' }, 'R²')));
  const tbody = h('tbody', {}, r.runs.map((run, i) => {
    const a = r.attribution[i];
    return h('tr', {},
      h('th', { scope: 'row', class: 'txt' }, h('span', { class: 'series-name' }, keySwatch(run.id), SHORT[run.id] || run.name)),
      h('td', {}, h('span', { class: Math.abs(a.t[0]) >= 1.96 ? 'strong' : '' }, fmt(a.beta[0] * 12, 'pct', 1)), h('span', { class: 'sub' }, `t = ${tfmt(a.t[0])}`)),
      a.beta.slice(1).map((b, k) => h('td', {}, fmt(b), h('span', { class: 'sub' }, `(${tfmt(a.t[k + 1], 1)})`))),
      h('td', {}, fmt(a.r2)));
  }));
  wrap.appendChild(h('table', { class: 'data' }, h('caption', { class: 'visually-hidden' }, 'Factor regression per strategy'), thead, tbody));
  $('#attr-caption').textContent = `OLS on the ${names.slice(1).map(n => FACT[n] || n).join(', ')} factors (Fama & French 1993; Carhart 1997), Newey–West standard errors with ${r.attribution[0].lags} lags. Alpha is the monthly intercept × 12. A t-stat beyond ±1.96 is conventionally called significant; with many strategies tried, some will pass by chance. R² is the share of month-to-month variation the factors explain. An R² of 1.00 means the strategy is the factor itself (buy-and-hold is the market), so its t-stats are meaningless.`;
}

// ---------- Exposure and weights ----------
function renderExposure(r) {
  const run = r.runs.find(x => x.id === state.exposureId) || r.runs[0];
  const universe = ['Market', ...state.info.assetNames];
  const labels = { Market: 'Market', ...(state.raw.assetLabels || {}) };
  const elE = $('#chart-exposure');
  const legend = h('div', { class: 'legend-html' },
    h('span', {}, lineKey(0, null, { width: 22, height: 10 }), 'Gross exposure'),
    h('span', {}, lineKey(6, [5, 3], { width: 22, height: 10 }), 'Net exposure (longs − shorts)'));
  const prev = elE.previousElementSibling;
  if (prev && prev.classList.contains('legend-html')) prev.remove();
  elE.before(legend);
  makeChart(elE, (t, width) => ({
    ...chartBase(t), grid: gridFor(width),
    tooltip: axisTooltip(t, i => [{ name: 'Gross', slot: 0 }, { name: 'Net', slot: 6, dashed: true }][i], v => fmt(v, 'x')),
    xAxis: timeX(t, run.dates),
    yAxis: { type: 'value', ...axisStyle(t), axisLabel: { color: t.ink3, fontSize: 11, formatter: v => fmt(v, 'x', 1) } },
    series: [
      { name: 'Gross exposure', type: 'line', data: run.grossExposure, showSymbol: false, lineStyle: { width: 1.5, color: t.series[0] }, itemStyle: { color: t.series[0] }, areaStyle: { color: t.series[0], opacity: 0.1 }, emphasis: { disabled: true } },
      { name: 'Net exposure', type: 'line', data: run.netExposure, showSymbol: false, lineStyle: { width: 1.5, color: t.series[6], type: [5, 3] }, itemStyle: { color: t.series[6] }, emphasis: { disabled: true } },
    ],
  }));

  // Weights as a diverging heat map: rows = holdings, columns = months.
  const elW = $('#chart-weights');
  const data = [];
  const abs = [];
  run.weights.forEach((w, x) => w.forEach((v, y) => { if (Math.abs(v) > 1e-9) { data.push([x, universe.length - 1 - y, v]); abs.push(Math.abs(v)); } }));
  abs.sort((a, b) => a - b);
  const cap = abs.length ? Math.max(abs[Math.floor(abs.length * 0.98)] || abs[abs.length - 1], 1e-6) : 1;
  const capped = abs.length && abs[abs.length - 1] > cap * 1.0001;
  $('#weights-caption').textContent = `Weights of ${run.name}. Blank cells: no position. Colour scale spans ±${fmt(cap, 'x')}` + (capped ? `; larger positions (up to ${fmt(abs[abs.length - 1], 'x', 1)}) are shown at the darkest shade. Hover a cell for its exact value.` : '. Hover a cell for its exact value.');
  const ylabels = universe.slice().reverse();
  makeChart(elW, (t, width) => ({
    ...chartBase(t),
    grid: { left: width < 500 ? 52 : 64, right: 12, top: 6, bottom: 64 },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: p => tooltipDom(`${monthLabel(run.dates[p.value[0]])}: ${labels[ylabels[p.value[1]]] || ylabels[p.value[1]]}`, [{ name: p.value[2] >= 0 ? 'Long' : 'Short', value: fmt(p.value[2], 'x', 3), slot: p.value[2] >= 0 ? 0 : 1 }]) },
    xAxis: { type: 'category', data: run.dates, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink3, fontSize: 11, formatter: yearLabel, hideOverlap: true } },
    yAxis: { type: 'category', data: ylabels, ...axisStyle(t, { splitLine: { show: false } }), axisLabel: { color: t.ink2, fontSize: 11, interval: 0 } },
    visualMap: {
      min: -cap, max: cap, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, itemHeight: width < 500 ? 140 : 220,
      text: [`long ${fmt(cap, 'x', 2)}`, `short ${fmt(cap, 'x', 2)}`], textStyle: { color: t.ink2, fontSize: 11 },
      inRange: { color: t.diverging },
    },
    series: [{ type: 'heatmap', data, progressive: 0, emphasis: { disabled: true } }],
  }));
}

// ---------- Notes ----------
function renderNotes(r) {
  const box = clear($('#notes'));
  const withNotes = r.runs.filter(x => x.notes.length);
  if (!withNotes.length) { box.appendChild(h('p', { class: 'small muted' }, 'No events recorded for this configuration.')); return; }
  for (const run of withNotes) {
    const shown = run.notes.slice(0, 12);
    box.appendChild(h('div', { class: 'notes-group' },
      h('h3', { class: 'small' }, h('span', { class: 'series-name' }, keySwatch(run.id), run.name), ` · ${run.notes.length} ${run.notes.length === 1 ? 'note' : 'notes'}`),
      h('ul', { class: 'notes-list' }, shown.map(n => h('li', {}, n))),
      run.notes.length > shown.length ? h('details', {}, h('summary', { class: 'small' }, `Show all ${run.notes.length}`), h('ul', { class: 'notes-list' }, run.notes.slice(12).map(n => h('li', {}, n)))) : null));
  }
}

// ---------------- Boot ----------------
async function boot() {
  renderPicker();
  renderBenchmarkSelect();
  initConditions();
  initDataPanel();
  if (typeof echarts === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  let local = null;
  try { local = await fetchLocalDataset(); } catch (err) { $('#data-error').textContent = err.message; }
  if (local) {
    state.localAvailable = true;
    await useDataset(local, 'local');
  } else {
    $('#drop-details').open = true;
    await useDataset(makeSyntheticDataset(7), 'synthetic');
  }
}
boot().catch(err => { setStatus('error', err.message); });
