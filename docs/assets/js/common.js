// Shared helpers for every page: theme toggle, DOM building, formatting, citations, math, chart theming.
// No innerHTML with data: text goes in via textContent so labels from data files can never inject markup.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Build an element: h('div', {class: 'x', onclick: fn, dataset: {a: 1}}, 'text', child, [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = tag.startsWith('svg:')
    ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4))
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') throw new Error('Inline styles are not allowed (CSP).');
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') el.appendChild(document.createTextNode(String(c))); // text is never parsed as HTML
    else if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// ---------- Theme ----------
const THEME_KEY = 'ss-theme';
const themeListeners = new Set();
export function currentTheme() {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function onThemeChange(fn) { themeListeners.add(fn); }
function emitTheme() { for (const fn of themeListeners) fn(currentTheme()); }
export function initThemeToggle() {
  const btn = $('#theme-toggle');
  const label = () => { if (btn) btn.textContent = currentTheme() === 'dark' ? 'Light theme' : 'Dark theme'; };
  label();
  btn?.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
    label(); emitTheme();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { label(); emitTheme(); });
}

/** Read resolved CSS custom properties (so charts use the same tokens as the page, in either theme). */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  return {
    page: g('--page'), surface: g('--surface'), surface2: g('--surface-2'), ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'),
    rule: g('--rule'), ruleStrong: g('--rule-strong'), grid: g('--grid'), axis: g('--axis'), accent: g('--accent'),
    danger: g('--danger'), caution: g('--caution-rule'),
    series: [1, 2, 3, 4, 5, 6, 7].map(i => g('--s' + i)),
    diverging: [g('--div-neg-2'), g('--div-neg-1'), g('--div-mid'), g('--div-pos-1'), g('--div-pos-2')],
    font: g('--font-ui'),
  };
}

// ---------- Series identity (fixed per strategy, never by rank) ----------
// Color slot + dash pattern + end-marker shape, so color is never the only carrier of identity.
export const SERIES_STYLE = [
  { slot: 0, dash: null, symbol: 'circle' },
  { slot: 1, dash: [9, 4], symbol: 'rect' },
  { slot: 2, dash: [2, 3], symbol: 'triangle' },
  { slot: 3, dash: [12, 3, 2, 3], symbol: 'diamond' },
  { slot: 4, dash: [5, 3], symbol: 'roundRect' },
  { slot: 5, dash: [14, 4, 3, 4, 3, 4], symbol: 'pin' },
  { slot: 6, dash: [1, 3, 7, 3], symbol: 'arrow' },
];

/** A small SVG line key (colour via CSS class, dash via SVG attribute: both CSP-safe). */
export function lineKey(slot, dash, { width = 26, height = 12 } = {}) {
  const svg = h('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', class: 'pick__key' });
  svg.appendChild(h('svg:line', {
    x1: 1, y1: height / 2, x2: width - 1, y2: height / 2,
    class: `key-s${slot + 1}`, 'stroke-width': 2.5, 'stroke-linecap': 'butt',
    'stroke-dasharray': dash ? dash.join(' ') : null,
  }));
  return svg;
}

// ---------- Formatting ----------
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const cache = {};
const fmtN = (x, d) => (cache[d] ||= nf(d)).format(x);
export const MINUS = '−';
const sign = s => s.replace(/^-/, MINUS);
export function fmt(x, kind = 'num', digits) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return MINUS + '∞';
  switch (kind) {
    case 'pct': return sign(fmtN(x * 100, digits ?? 1)) + '%';
    case 'prob': return fmtN(x, digits ?? 2);
    case 'x': return sign(fmtN(x, digits ?? 2)) + '×';
    case 'bps': return sign(fmtN(x, digits ?? 0)) + ' bps';
    case 'int': return sign(fmtN(x, 0));
    case 'p': return x < 0.001 ? '< 0.001' : fmtN(x, 3);
    default: return sign(fmtN(x, digits ?? 2));
  }
}
export const monthLabel = ym => {
  const [y, m] = ym.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// ---------- Citations ----------
let citationsPromise = null;
export function loadCitations() {
  citationsPromise ||= fetch('data/citations.json', { credentials: 'same-origin' })
    .then(r => { if (!r.ok) throw new Error('citations.json: HTTP ' + r.status); return r.json(); })
    .then(list => new Map(list.map(c => [c.key, c])));
  return citationsPromise;
}
export function authorsShort(c) {
  const a = c.authors || [];
  if (!a.length) return c.publisher || c.title;
  const fam = a.map(x => x.family || x.literal || x.name || '');
  if (fam.length === 1) return fam[0];
  if (fam.length === 2) return `${fam[0]} & ${fam[1]}`;
  if (fam.length === 3) return `${fam[0]}, ${fam[1]} & ${fam[2]}`;
  return `${fam[0]} et al.`;
}
export function authorsFull(c) {
  const a = c.authors || [];
  if (!a.length) return '';
  const names = a.map(x => x.literal || x.name || [x.family, x.given ? x.given.split(/[\s-]+/).map(p => p[0] + '.').join(' ') : ''].filter(Boolean).join(', '));
  return names.length > 1 ? names.slice(0, -1).join('; ') + ' & ' + names[names.length - 1] : names[0];
}
/** "Authors (year), Journal" + DOI link + where-note. */
export function citationNode(c, where) {
  if (!c) return h('p', { class: 'ref' }, 'Missing reference');
  const doiUrl = c.doi ? 'https://doi.org/' + c.doi : c.url;
  return h('p', { class: 'ref' },
    h('a', { href: `sources.html#ref-${c.key}` }, `${authorsShort(c)} (${c.year ?? 'n.d.'})`),
    c.journal ? [', ', h('i', {}, c.journal)] : '',
    doiUrl ? [' · ', h('a', { href: doiUrl, rel: 'noopener noreferrer' }, c.doi ? 'doi:' + c.doi : 'link')] : '',
    where ? h('span', { class: 'where' }, where) : '');
}

// ---------- Math ----------
export function renderTex(el, tex, displayMode = true) {
  if (typeof katex === 'undefined') { el.textContent = tex; return el; }
  katex.render(tex, el, { output: 'mathml', throwOnError: false, displayMode });
  return el;
}
export function texNode(tex, displayMode = true, tag = 'div') {
  return renderTex(h(tag, { class: displayMode ? 'eq__math' : 'tex-inline' }), tex, displayMode);
}

// ---------- Popovers (definitions next to numbers) ----------
let openPopover = null;
export function helpButton(labelText, buildContent) {
  const btn = h('button', { type: 'button', class: 'help-btn', 'aria-expanded': 'false', 'aria-label': `What is ${labelText}?` }, '?');
  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    if (openPopover && openPopover.btn === btn) { closePopover(); return; }
    closePopover();
    const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': labelText }, buildContent());
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(window.scrollX + r.left - w / 2 + r.width / 2, window.scrollX + document.documentElement.clientWidth - w - 8));
    pop.style.left = left + 'px'; // CSSOM property assignment: allowed under style-src 'self'
    pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    openPopover = { btn, pop };
    pop.setAttribute('tabindex', '-1');
  });
  return btn;
}
export function closePopover() {
  if (!openPopover) return;
  openPopover.pop.remove();
  openPopover.btn.setAttribute('aria-expanded', 'false');
  openPopover = null;
}
document.addEventListener('click', e => { if (openPopover && !openPopover.pop.contains(e.target)) closePopover(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openPopover) { const b = openPopover.btn; closePopover(); b.focus(); }
});
window.addEventListener('resize', closePopover);

// ---------- Charts ----------
/** Base ECharts options matching the page tokens (hairline recessive axes, system font). */
export function chartBase(t) {
  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: t.font, color: t.ink2, fontSize: 12 },
    aria: { enabled: true },
  };
}
export function axisStyle(t, extra = {}) {
  return {
    axisLine: { lineStyle: { color: t.axis, width: 1 } },
    axisTick: { lineStyle: { color: t.axis } },
    axisLabel: { color: t.ink3, fontSize: 11, hideOverlap: true },
    splitLine: { lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    nameTextStyle: { color: t.ink3, fontSize: 11 },
    ...extra,
  };
}
export function tooltipBase(t) {
  return {
    backgroundColor: t.surface, borderColor: t.ruleStrong, borderWidth: 1, padding: [8, 10],
    textStyle: { color: t.ink, fontFamily: t.font, fontSize: 12 },
    extraCssText: 'box-shadow: 0 6px 20px rgba(15,25,35,.18); border-radius: 6px;',
    confine: true,
    axisPointer: { lineStyle: { color: t.ink3, width: 1 }, crossStyle: { color: t.ink3 } },
  };
}
/** Tooltip body as DOM (never an HTML string, so no inline style attributes reach the page). */
export function tooltipDom(title, rows, note) {
  const box = h('div', { class: 'tt' }, h('div', { class: 'tt__title' }, title));
  for (const r of rows) {
    const key = h('span', { class: `tt__key key-bg-s${(r.slot ?? 0) + 1}${r.dashed ? ' tt__key--dash key-fg-s' + ((r.slot ?? 0) + 1) : ''}` });
    box.appendChild(h('div', { class: 'tt__row' }, key, h('span', { class: 'tt__name' }, r.name), h('span', { class: 'tt__val' }, r.value)));
  }
  if (note) box.appendChild(h('div', { class: 'tt__note' }, note));
  return box;
}

const charts = new Set();
/** Create (or reuse) an ECharts instance bound to an element; re-rendered on theme change and resize. */
export function makeChart(el, render) {
  const existing = [...charts].find(c => c.el === el);
  if (existing) { existing.render = render; existing.draw(); return existing; }
  let inst = echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' });
  const entry = { el, inst, render };
  charts.add(entry);
  entry.draw = () => { inst.setOption(entry.render(tokens(), el.clientWidth), { notMerge: true }); };
  entry.draw();
  return entry;
}
onThemeChange(() => { for (const c of charts) c.draw(); });
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const c of charts) { if (!c.el.isConnected) { charts.delete(c); continue; } c.inst.resize(); c.draw(); } }, 120);
});

/** Toggle a figure's table-view twin. */
export function tableToggle(button, container, buildTable) {
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const open = container.hidden;
    if (open) { clear(container); container.appendChild(buildTable()); }
    container.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide table' : 'Show as table';
  });
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function initPage() {
  initThemeToggle();
}
