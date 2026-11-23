// Trading floor page: a simulated market, paper orders and a command line. Everything runs in this tab; nothing is
// fetched, stored or sent. Engine: docs/engine/floor/ (market.js, paper.js, commands.js), tested in tests/js/floor.test.mjs.
import { createMarket, step, depth, aggregateBars, vwap, findInstrument, clock, BAR_SECONDS, SECONDS_PER_YEAR } from '../../engine/floor/market.js';
import { createAccount, submit, onTick, cancel, markToMarket } from '../../engine/floor/paper.js';
import { parse, complete, HELP, PANELS } from '../../engine/floor/commands.js';
import { $, $$, h, clear, initPage, MINUS } from './common.js';

initPage();

const DEFAULT_SEED = 7;
const WARMUP = 75 * 60; // open the page 75 simulated minutes into the session, so the chart has history
const FRAME_MS = 250;
const TAPE_ROWS = 60;
const SPARK_BARS = 60;

const S = {
  mkt: null, acct: null, sel: 0, interval: 1, speed: 1, running: true, carry: 0,
  history: [], hIdx: 0, chart: null, chartDirty: true, lastBarCount: 0, lastChartAt: 0, prevLast: [],
};

// ---------------------------------------------------------------- formatting
const px = x => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(2));
const signed = (x, d = 2) => (x > 0 ? '+' : x < 0 ? MINUS : '') + Math.abs(x).toFixed(d);
const money = x => (x < 0 ? MINUS : x > 0 ? '+' : '') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = q => (q < 0 ? MINUS : '') + Math.abs(q).toLocaleString('en-US');
function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-US');
}
const dir = x => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
const arrow = x => (x > 0 ? '▲' : x < 0 ? '▼' : '■');

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setDir(el, x) { el.classList.toggle('is-up', x > 0); el.classList.toggle('is-down', x < 0); }
function flash(el, x) {
  if (!x) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(x > 0 ? 'flash-up' : 'flash-down');
}

// ---------------------------------------------------------------- messages
const msgEl = $('#cmd-msg');
function say(text, kind = 'info') {
  msgEl.textContent = text;
  msgEl.dataset.kind = kind;
}

// ---------------------------------------------------------------- watchlist
const watchRows = [];
function buildWatch() {
  const body = clear($('#watch-body'));
  watchRows.length = 0;
  S.mkt.inst.forEach((s, i) => {
    const spark = h('svg:svg', { class: 'spark', viewBox: '0 0 60 18', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const line = h('svg:polyline', { class: 'spark__line' });
    spark.appendChild(line);
    const cells = { last: h('td', { class: 'r num' }), chg: h('td', { class: 'r num' }), pct: h('td', { class: 'r num' }), vol: h('td', { class: 'r num dim' }) };
    const tr = h('tr', { tabindex: '0', dataset: { i: String(i) }, 'aria-selected': 'false' },
      h('th', { scope: 'row' }, h('span', { class: 'sym' }, s.sym.replace('.SIM', '')), h('span', { class: 'sym__sfx' }, '.SIM')),
      cells.last, cells.chg, cells.pct, cells.vol, h('td', { class: 'spark-cell' }, spark));
    tr.addEventListener('click', () => select(i));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + watchRows.length) % watchRows.length;
        select(j); watchRows[j].tr.focus();
      }
    });
    body.appendChild(tr);
    watchRows.push({ tr, line, ...cells });
  });
  setText($('#watch-meta'), `${S.mkt.inst.length} simulated`);
}

function renderWatch() {
  S.mkt.inst.forEach((s, i) => {
    const r = watchRows[i];
    const chg = s.last - s.prevClose;
    const prev = S.prevLast[i];
    setText(r.last, px(s.last));
    if (prev !== undefined && prev !== s.last) flash(r.last, s.last - prev);
    S.prevLast[i] = s.last;
    setText(r.chg, signed(chg));
    setText(r.pct, `${arrow(chg)} ${signed((chg / s.prevClose) * 100)}%`);
    setDir(r.chg, chg); setDir(r.pct, chg);
    setText(r.vol, compact(s.volume));
    const closes = s.bars.slice(-SPARK_BARS).map(b => b.c);
    const lo = Math.min(...closes), hi = Math.max(...closes), span = hi - lo || 1;
    r.line.setAttribute('points', closes.map((c, k) => `${((k / Math.max(1, closes.length - 1)) * 60).toFixed(1)},${(17 - ((c - lo) / span) * 16).toFixed(1)}`).join(' '));
    r.line.setAttribute('class', `spark__line spark__line--${dir(closes[closes.length - 1] - closes[0])}`);
  });
}

// ---------------------------------------------------------------- chart
function chartOption() {
  const s = S.mkt.inst[S.sel];
  const bars = aggregateBars(s.bars, S.interval).slice(-180);
  const x = bars.map(b => clock(b.t).slice(0, 5));
  let cumV = 0, cumPV = 0;
  const all = aggregateBars(s.bars, S.interval);
  const vw = [];
  for (const b of all) { cumV += b.v; cumPV += ((b.h + b.l + b.c) / 3) * b.v; vw.push(cumV ? cumPV / cumV : null); }
  const vwLine = vw.slice(-bars.length);
  const css = getComputedStyle(document.documentElement);
  const c = n => css.getPropertyValue(n).trim();
  const up = c('--f-up'), down = c('--f-down'), ink = c('--f-ink'), dim = c('--f-dim'), rule = c('--f-rule'), grid = c('--f-grid'), accent = c('--f-accent');
  const mono = c('--f-mono');
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: mono, color: dim, fontSize: 11 },
    grid: [{ left: 8, right: 64, top: 10, height: '68%' }, { left: 8, right: 64, top: '78%', bottom: 22 }],
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: rule, color: ink, fontFamily: mono } },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross', lineStyle: { color: dim, type: 'dashed' }, crossStyle: { color: dim } },
      backgroundColor: c('--f-panel-2'), borderColor: rule, textStyle: { color: ink, fontFamily: mono, fontSize: 12 },
      formatter: ps => {
        const k = ps[0]?.dataIndex; const b = bars[k]; if (!b) return '';
        const lines = [`${s.sym}  ${clock(b.t)}  ${S.interval}m`, `O ${px(b.o)}  H ${px(b.h)}`, `L ${px(b.l)}  C ${px(b.c)}`, `Vol ${b.v.toLocaleString('en-US')}`, `VWAP ${px(vwLine[k])}`];
        return lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
      },
    },
    xAxis: [
      { type: 'category', data: x, boundaryGap: true, axisLine: { lineStyle: { color: rule } }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false } },
      { type: 'category', gridIndex: 1, data: x, boundaryGap: true, axisLine: { lineStyle: { color: rule } }, axisTick: { show: false }, axisLabel: { color: dim, hideOverlap: true } },
    ],
    yAxis: [
      { scale: true, position: 'right', splitNumber: 6, axisLine: { show: false }, axisLabel: { color: dim, formatter: v => v.toFixed(2) }, splitLine: { lineStyle: { color: grid } } },
      { scale: true, gridIndex: 1, position: 'right', splitNumber: 2, axisLine: { show: false }, axisLabel: { color: dim, formatter: v => compact(v) }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
    series: [
      {
        name: s.sym, type: 'candlestick', data: bars.map(b => [b.o, b.c, b.l, b.h]),
        itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down },
        markLine: {
          symbol: 'none', silent: true, animation: false,
          label: { position: 'end', color: c('--f-bg'), backgroundColor: s.last >= s.prevClose ? up : down, padding: [2, 4], fontFamily: mono, formatter: px(s.last) },
          lineStyle: { color: s.last >= s.prevClose ? up : down, type: 'dotted', width: 1 },
          data: [{ yAxis: s.last }],
        },
      },
      { name: 'VWAP', type: 'line', data: vwLine, showSymbol: false, lineStyle: { color: accent, width: 1.2 }, z: 3 },
      {
        name: 'Volume', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barCategoryGap: '20%',
        data: bars.map(b => ({ value: b.v, itemStyle: { color: b.c >= b.o ? up : down, opacity: 0.55 } })),
      },
    ],
  };
}

function initChart() {
  const el = $('#chart');
  if (typeof echarts === 'undefined') { setText(el, 'Chart library failed to load.'); return; }
  S.chart = echarts.init(el, null, { renderer: 'canvas' });
  new ResizeObserver(() => S.chart.resize()).observe(el);
}

function renderChart() {
  if (!S.chart) return;
  S.chart.setOption(chartOption(), { notMerge: true, lazyUpdate: true });
  S.chartDirty = false;
}

function renderChartHead() {
  const s = S.mkt.inst[S.sel];
  const chg = s.last - s.prevClose;
  setText($('#chart-sym'), s.sym);
  setText($('#chart-name'), `${s.name} · ${s.sector}`);
  setText($('#chart-last'), px(s.last));
  const ch = $('#chart-chg');
  setText(ch, `${arrow(chg)} ${signed(chg)} (${signed((chg / s.prevClose) * 100)}%)`);
  setDir(ch, chg);
}

// ---------------------------------------------------------------- depth
const depthRows = [];
function buildDepth() {
  const body = clear($('#depth-body'));
  depthRows.length = 0;
  for (let k = 0; k < 10; k++) {
    const mk = side => {
      const b = h('button', { type: 'button', class: `lvl lvl--${side}` });
      b.addEventListener('click', () => prefillLimit(side === 'bid' ? 'buy' : 'sell', Number(b.dataset.px)));
      return b;
    };
    const bidPx = mk('bid'), askPx = mk('ask');
    const bidSz = h('td', { class: 'r num sz sz--bid' }), askSz = h('td', { class: 'num sz sz--ask' });
    body.appendChild(h('tr', {}, bidSz, h('td', { class: 'r num' }, bidPx), h('td', { class: 'num' }, askPx), askSz));
    depthRows.push({ bidPx, askPx, bidSz, askSz });
  }
}

function renderDepth() {
  const s = S.mkt.inst[S.sel];
  const book = depth(S.mkt, S.sel);
  const max = Math.max(...book.bids.map(l => l.size), ...book.asks.map(l => l.size));
  const working = new Map();
  for (const o of S.acct.orders) if (o.status === 'working' && o.sym === s.sym) working.set(`${o.side}${o.limit.toFixed(2)}`, true);
  book.bids.forEach((l, k) => {
    const r = depthRows[k];
    setText(r.bidPx, (working.has(`B${l.px.toFixed(2)}`) ? '● ' : '') + px(l.px));
    r.bidPx.dataset.px = String(l.px);
    r.bidPx.setAttribute('aria-label', `Prepare a buy limit at ${px(l.px)}`);
    setText(r.bidSz, l.size.toLocaleString('en-US'));
    r.bidSz.style.setProperty('--w', (l.size / max).toFixed(3));
  });
  book.asks.forEach((l, k) => {
    const r = depthRows[k];
    setText(r.askPx, px(l.px) + (working.has(`S${l.px.toFixed(2)}`) ? ' ●' : ''));
    r.askPx.dataset.px = String(l.px);
    r.askPx.setAttribute('aria-label', `Prepare a sell limit at ${px(l.px)}`);
    setText(r.askSz, l.size.toLocaleString('en-US'));
    r.askSz.style.setProperty('--w', (l.size / max).toFixed(3));
  });
  const spread = s.ask - s.bid;
  setText($('#depth-meta'), `${s.sym.replace('.SIM', '')} · spread ${spread.toFixed(2)} (${((spread / ((s.ask + s.bid) / 2)) * 1e4).toFixed(1)} bp)`);
}

function prefillLimit(side, price) {
  const s = S.mkt.inst[S.sel];
  const q = Math.max(1, Math.round(Number($('#ticket-qty').value) || 100));
  const input = $('#cmd');
  input.value = `${side} ${q} ${s.sym.replace('.SIM', '').toLowerCase()} @ ${price.toFixed(2)}`;
  input.focus();
  say('Limit order prepared. Press Enter to send it, Esc to drop it.');
}

// ---------------------------------------------------------------- tape
function renderTape() {
  const s = S.mkt.inst[S.sel];
  const body = $('#tape-body');
  const trades = s.tape.slice(-TAPE_ROWS).reverse();
  const key = trades.length ? `${s.sym}${trades[0].t}${trades.length}${s.trades}` : s.sym;
  if (body.dataset.key === key) return;
  body.dataset.key = key;
  clear(body);
  for (let k = 0; k < trades.length; k++) {
    const t = trades[k], older = trades[k + 1];
    const tickDir = older ? t.px - older.px : 0;
    const big = t.size >= 5000;
    body.appendChild(h('tr', { class: `tp tp--${t.side === 'B' ? 'buy' : 'sell'}${big ? ' tp--big' : ''}` },
      h('td', { class: 'num dim' }, clock(t.t)),
      h('td', { class: `r num ${tickDir > 0 ? 'is-up' : tickDir < 0 ? 'is-down' : ''}` }, `${px(t.px)} ${tickDir > 0 ? '↑' : tickDir < 0 ? '↓' : ' '}`),
      h('td', { class: 'r num' }, t.size.toLocaleString('en-US')),
      h('td', {}, t.side === 'B' ? 'at ask' : 'at bid')));
  }
  setText($('#tape-meta'), `${s.sym.replace('.SIM', '')} · ${s.trades.toLocaleString('en-US')} prints`);
}

// ---------------------------------------------------------------- orders and positions
function renderBlotter() {
  const body = $('#blotter-body');
  const key = S.acct.orders.map(o => `${o.id}${o.status}${o.filled}`).join('|');
  if (body.dataset.key === key) return;
  body.dataset.key = key;
  clear(body);
  for (const o of [...S.acct.orders].reverse()) {
    const x = o.status === 'working' ? h('button', { type: 'button', class: 'cxl', 'aria-label': `Cancel order ${o.id}`, onclick: () => run(`cancel ${o.id}`) }, '×') : '';
    body.appendChild(h('tr', { class: `ord ord--${o.status}` },
      h('td', { class: 'r num dim' }, String(o.id)),
      h('td', { class: 'num dim' }, clock(o.t)),
      h('td', { class: o.side === 'B' ? 'is-up' : 'is-down' }, o.side === 'B' ? 'BUY' : 'SELL'),
      h('td', { class: 'r num' }, o.qty.toLocaleString('en-US')),
      h('td', {}, o.sym.replace('.SIM', '')),
      h('td', { class: 'r num' }, o.type === 'limit' ? px(o.limit) : 'MKT'),
      h('td', { class: 'r num' }, o.filled.toLocaleString('en-US')),
      h('td', { class: 'r num' }, px(o.avgPx)),
      h('td', { class: 'status' }, o.status),
      h('td', {}, x)));
  }
  $('#blotter-empty').hidden = S.acct.orders.length > 0;
  const working = S.acct.orders.filter(o => o.status === 'working').length;
  setText($('#blotter-meta'), `${working} working · ${S.acct.fills.length} fills`);
}

function renderRisk() {
  const r = markToMarket(S.acct, S.mkt);
  const body = clear($('#risk-body'));
  for (const p of r.rows) {
    const tr = h('tr', { tabindex: '0', class: 'pos' },
      h('th', { scope: 'row' }, p.sym.replace('.SIM', '')),
      h('td', { class: `r num ${p.qty > 0 ? 'is-up' : p.qty < 0 ? 'is-down' : 'dim'}` }, qtyFmt(p.qty)),
      h('td', { class: 'r num' }, p.qty ? px(p.avgPx) : '—'),
      h('td', { class: `r num ${p.unrealized > 0 ? 'is-up' : p.unrealized < 0 ? 'is-down' : ''}` }, money(p.unrealized)),
      h('td', { class: `r num ${p.realized > 0 ? 'is-up' : p.realized < 0 ? 'is-down' : ''}` }, money(p.realized)));
    tr.addEventListener('click', () => select(findInstrument(S.mkt, p.sym)));
    body.appendChild(tr);
  }
  if (!r.rows.length) body.appendChild(h('tr', {}, h('td', { colspan: '5', class: 'dim' }, 'Flat. No paper positions.')));
  const foot = clear($('#risk-foot'));
  foot.appendChild(h('tr', {},
    h('th', { scope: 'row', colspan: '3' }, `Total · gross ${compact(Math.round(r.gross))}`),
    h('td', { class: `r num ${r.unrealized > 0 ? 'is-up' : r.unrealized < 0 ? 'is-down' : ''}` }, money(r.unrealized)),
    h('td', { class: `r num ${r.realized > 0 ? 'is-up' : r.realized < 0 ? 'is-down' : ''}` }, money(r.realized))));
  setText($('#risk-meta'), `net ${money(r.total)}`);
  $('#risk-meta').classList.toggle('is-up', r.total > 0);
  $('#risk-meta').classList.toggle('is-down', r.total < 0);
  renderStats();
}

function renderStats() {
  const s = S.mkt.inst[S.sel];
  const recent = s.bars.slice(-31).map(b => b.c);
  const rets = recent.slice(1).map((c, k) => Math.log(c / recent[k]));
  const mu = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const v = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, rets.length - 1);
  const rv = Math.sqrt(v * (SECONDS_PER_YEAR / BAR_SECONDS)) * 100;
  const pairs = [
    ['VWAP', px(vwap(s))], ['Open', px(s.open)], ['Day range', `${px(s.dayLow)} – ${px(s.dayHigh)}`], ['Prev close', px(s.prevClose)],
    ['Realised vol, 30m', `${rv.toFixed(1)}%`], ['Beta (model)', s.beta.toFixed(2)],
  ];
  const dl = clear($('#stats'));
  for (const [k, val] of pairs) dl.appendChild(h('div', { class: 'kv__row' }, h('dt', {}, k), h('dd', { class: 'num' }, val)));
}

// ---------------------------------------------------------------- frame loop
function renderAll() {
  setText($('#clock'), clock(S.mkt.t));
  renderWatch();
  renderChartHead();
  renderDepth();
  renderTape();
  renderBlotter();
  renderRisk();
  const bars = S.mkt.inst[S.sel].bars.length;
  const now = performance.now();
  if (S.chartDirty || bars !== S.lastBarCount || now - S.lastChartAt > 750) { S.lastBarCount = bars; S.lastChartAt = now; renderChart(); }
}

function frame() {
  if (S.running && !document.hidden) {
    S.carry += (S.speed * FRAME_MS) / 1000;
    const n = Math.floor(S.carry);
    S.carry -= n;
    const filled = [];
    for (let k = 0; k < n; k++) { step(S.mkt); filled.push(...onTick(S.acct, S.mkt)); }
    for (const o of filled) say(`Filled #${o.id}: ${o.side === 'B' ? 'bought' : 'sold'} ${o.qty.toLocaleString('en-US')} ${o.sym} at ${px(o.avgPx)} (paper).`, 'ok');
    if (n) renderAll();
  }
}

// ---------------------------------------------------------------- commands
function select(i) {
  if (i < 0) return;
  S.sel = i;
  watchRows.forEach((r, k) => { r.tr.setAttribute('aria-selected', String(k === i)); r.tr.classList.toggle('is-sel', k === i); });
  S.chartDirty = true;
  $('#tape-body').dataset.key = '';
  renderAll();
}

function setRunning(on) {
  S.running = on;
  const b = $('#playpause');
  b.textContent = on ? 'Pause' : 'Play';
  b.setAttribute('aria-pressed', String(!on));
  document.body.classList.toggle('is-paused', !on);
}

function setBarInterval(k) {
  S.interval = k;
  $$('[data-interval]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.interval) === k)));
  S.chartDirty = true;
  renderChart();
}

function maximise(panel) {
  const grid = $('#grid');
  if (panel) grid.dataset.max = panel; else delete grid.dataset.max;
  S.chart?.resize();
}

function reset(seed = DEFAULT_SEED) {
  S.mkt = createMarket({ seed, warmup: WARMUP });
  S.acct = createAccount();
  S.prevLast = [];
  S.carry = 0;
  setText($('#foot-seed'), `Seed ${seed}`);
  buildWatch();
  select(Math.min(S.sel, S.mkt.inst.length - 1));
}

function toggleHelp(open) {
  const el = $('#help');
  const show = open ?? el.hidden;
  el.hidden = !show;
  $('#help-btn').setAttribute('aria-expanded', String(show));
  if (show) $('#help-close').focus();
}

function run(text) {
  const c = parse(text);
  if (c.error) return say(c.error, 'err');
  switch (c.cmd) {
    case 'noop': return;
    case 'help': toggleHelp(true); return say('Commands listed. Esc closes the list.');
    case 'clear': return say('');
    case 'pause': setRunning(false); return say('Simulated clock paused.');
    case 'play': setRunning(true); return say('Simulated clock running.');
    case 'restore': maximise(null); return say('Grid restored.');
    case 'max': maximise(c.panel); return say(`${c.panel} enlarged. Type restore to go back.`);
    case 'interval': setBarInterval(c.minutes); return say(`${c.minutes}-minute bars.`);
    case 'speed': S.speed = c.speed; setText($('#speed'), `${c.speed}×`); return say(`${c.speed} simulated second${c.speed > 1 ? 's' : ''} per second.`);
    case 'reset': reset(c.seed ?? DEFAULT_SEED); return say(`New simulated session, seed ${c.seed ?? DEFAULT_SEED}. Paper orders and positions cleared.`, 'ok');
    case 'load': {
      const i = findInstrument(S.mkt, c.sym);
      if (i < 0) return say(`Unknown symbol ${c.sym}. Symbols: ${S.mkt.inst.map(s => s.sym.replace('.SIM', '')).join(', ')}.`, 'err');
      select(i); return say(`${S.mkt.inst[i].sym} loaded.`);
    }
    case 'cancel': {
      const n = cancel(S.acct, c.id);
      renderAll();
      return n ? say(`Cancelled ${n} order${n > 1 ? 's' : ''}.`, 'ok') : say(c.id === 'all' ? 'No working orders.' : `Order #${c.id} is not working.`, 'err');
    }
    case 'flatten': {
      const rows = markToMarket(S.acct, S.mkt).rows.filter(p => p.qty !== 0 && (c.sym === 'all' || findInstrument(S.mkt, c.sym) === findInstrument(S.mkt, p.sym)));
      if (!rows.length) return say('Nothing to flatten.', 'err');
      for (const p of rows) submit(S.acct, S.mkt, { side: p.qty > 0 ? 'S' : 'B', qty: Math.abs(p.qty), sym: p.sym, type: 'market' });
      renderAll();
      return say(`Flattened ${rows.map(p => p.sym.replace('.SIM', '')).join(', ')} with market orders (paper).`, 'ok');
    }
    case 'order': {
      const r = submit(S.acct, S.mkt, c);
      if (r.error) return say(r.error, 'err');
      const o = r.order;
      renderAll();
      const what = `${o.side === 'B' ? 'Buy' : 'Sell'} ${o.qty.toLocaleString('en-US')} ${o.sym}${o.type === 'limit' ? ` @ ${px(o.limit)}` : ' at market'}`;
      if (o.status === 'filled') return say(`#${o.id} ${what}: filled at ${px(o.avgPx)} avg (paper).`, 'ok');
      return say(`#${o.id} ${what}: ${o.filled ? `${o.filled.toLocaleString('en-US')} filled, rest working` : 'working'} (paper).`, 'ok');
    }
    default: return say(`Not implemented: ${c.cmd}`, 'err');
  }
}

// ---------------------------------------------------------------- wiring
function wire() {
  const input = $('#cmd');
  $('#cmd-form').addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) { S.history.push(text); if (S.history.length > 100) S.history.shift(); }
    S.hIdx = S.history.length;
    input.value = '';
    run(text);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && S.history.length) { e.preventDefault(); S.hIdx = Math.max(0, S.hIdx - 1); input.value = S.history[S.hIdx]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); S.hIdx = Math.min(S.history.length, S.hIdx + 1); input.value = S.history[S.hIdx] || ''; }
    else if (e.key === 'Tab' && input.value.trim()) {
      e.preventDefault();
      const r = complete(input.value, S.mkt.inst.map(s => s.sym.replace('.SIM', '')));
      input.value = r.input;
      if (r.options.length > 1) say(r.options.join('  '));
    } else if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
  document.addEventListener('keydown', e => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === 'Escape' && !$('#help').hidden) { toggleHelp(false); input.focus(); return; }
    if (!typing && e.key === '/') { e.preventDefault(); input.focus(); return; }
    if (e.altKey && /^[1-6]$/.test(e.key)) {
      e.preventDefault();
      const p = $(`[data-panel="${PANELS[Number(e.key) - 1]}"]`);
      (p.querySelector('[tabindex="0"], button, input') || p).focus();
    }
  });
  $('#playpause').addEventListener('click', () => run(S.running ? 'pause' : 'play'));
  $('#help-btn').addEventListener('click', () => toggleHelp());
  $('#help-close').addEventListener('click', () => { toggleHelp(false); input.focus(); });
  $$('[data-interval]').forEach(b => b.addEventListener('click', () => setBarInterval(Number(b.dataset.interval))));
  const ticket = side => {
    const q = Math.round(Number($('#ticket-qty').value));
    run(`${side} ${q} ${S.mkt.inst[S.sel].sym.replace('.SIM', '').toLowerCase()}`);
  };
  $('#ticket-buy').addEventListener('click', () => ticket('buy'));
  $('#ticket-sell').addEventListener('click', () => ticket('sell'));
  const hb = $('#help-body');
  for (const [usage, about] of HELP) hb.appendChild(h('tr', {}, h('th', { scope: 'row' }, h('code', {}, usage)), h('td', {}, about)));
  $$('.fp').forEach(p => p.setAttribute('tabindex', '-1'));
}

/** The floor fills the viewport below the site header and notice (measured, since both wrap on narrow screens). */
function fitToViewport() {
  const chrome = ($('.site-header')?.offsetHeight || 0) + ($('.notice')?.offsetHeight || 0);
  document.documentElement.style.setProperty('--floor-chrome', `${chrome}px`);
}

function start() {
  fitToViewport();
  window.addEventListener('resize', fitToViewport);
  initChart();
  buildDepth();
  wire();
  reset(DEFAULT_SEED);
  setInterval(frame, FRAME_MS);
  document.body.dataset.ready = 'true';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
