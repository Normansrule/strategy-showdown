// Strategy cards page.
import { STRATEGIES } from '../../engine/strategies/index.js';
import { PAPER_SETTINGS } from '../../engine/sims/avellaneda-stoikov.js';
import { $, h, clear, initPage, loadCitations, citationNode, texNode, lineKey, SERIES_STYLE } from './common.js';
import { CONFIRMATION, LEVELS } from './confirmation.js';

initPage();

const EVIDENCE_LABEL = {
  'published-replicable': 'Published, replicable',
  'published-data-restricted': 'Published, data restricted',
  'public-description': 'Public description only',
  definition: 'Definition',
};

// The market-making model is a simulation, not a backtest strategy, so its card is defined here.
const AS_CARD = {
  id: 'avellaneda-stoikov',
  name: 'Market making (Avellaneda–Stoikov)',
  family: 'Market making',
  evidence: 'published-replicable',
  simulation: true,
  summary: 'Continuously post a price to buy (bid) and a price to sell (ask), earning the gap between them, while shading both quotes to keep inventory near zero.',
  intuition: 'A market maker earns the spread but carries inventory risk: if it has bought a lot and the price falls, it loses. The model moves both quotes down when inventory is long (and up when short) so that the next trade is more likely to bring inventory back towards zero.',
  equations: [
    { tex: 'r(s,q,t) = s - q\\,\\gamma\\,\\sigma^2\\,(T-t)', where: 'Reservation price, Eq. (8)/(29): s = mid price, q = inventory, γ = risk aversion, σ = volatility, T − t = time left.' },
    { tex: '\\delta^a + \\delta^b = \\gamma\\sigma^2(T-t) + \\tfrac{2}{\\gamma}\\ln\\!\\left(1 + \\tfrac{\\gamma}{k}\\right)', where: 'Total optimal spread, Eq. (30). k = how fast fill probability falls with distance from the mid.' },
    { tex: '\\lambda(\\delta) = A\\,e^{-k\\delta}', where: 'Arrival rate of orders that hit a quote at distance δ from the mid, Eq. (12).' },
  ],
  sources: [
    { key: 'avellaneda2008hft', where: 'Sec. 2–3; simulation settings in Sec. 3.3; results in Tables 1–3' },
    { key: 'glosten1985bidask', where: 'Background: why a bid-ask spread exists (adverse selection)' },
    { key: 'kyle1985continuous', where: 'Background: informed trading and market depth' },
  ],
  deviations: [
    'The benchmark “symmetric” strategy uses a constant spread equal to the inventory strategy’s average spread, centred on the mid price, as the paper specifies (Sec. 3.3).',
    'This is a simulation of the paper’s stylized market (a random-walk price and exponential fill probabilities), not a backtest on real order-book data.',
    'The spread formula was read from a garbled text extraction. The reading γσ²(T−t) + (2/γ)ln(1 + γ/k) is the one that reproduces the paper’s own average spreads (1.49, 1.35, 3.02); check the printed Eq. (30) before relying on it.',
  ],
  failureModes: ['Adverse selection: informed traders hit stale quotes (not modelled here)', 'Price jumps and fat tails (the model’s price moves in equal small steps)', 'Queue position, latency and fees, which decide real fills'],
  params: {
    gamma: { default: 0.1, min: 0.01, max: 1, label: 'Risk aversion γ', source: 'Paper: 0.01, 0.1, 1' },
    sigma: { default: PAPER_SETTINGS.sigma, label: 'Volatility σ', source: 'Paper Sec. 3.3: σ = 2' },
    k: { default: PAPER_SETTINGS.k, label: 'Fill decay k', source: 'Paper Sec. 3.3: k = 1.5' },
    A: { default: PAPER_SETTINGS.A, label: 'Order arrival A', source: 'Paper Sec. 3.3: A = 140' },
  },
  link: { href: 'market-making.html', text: 'Open the market-making simulator' },
};

function levelChip(level) {
  return h('span', { class: `chip chip--level-${level}`, title: LEVELS[level].explain }, LEVELS[level].label);
}

function card(s, citations, slot) {
  const conf = CONFIRMATION.filter(c => c.group === s.id);
  const left = h('div', {},
    h('p', { class: 'summary-line' }, s.summary),
    h('h3', {}, 'The idea'),
    h('p', { class: 'prose' }, s.intuition),
    h('h3', {}, 'Equations'),
    s.equations.map(eq => h('div', { class: 'eq' }, texNode(eq.tex), h('p', { class: 'eq__where' }, eq.where))),
    s.deviations.length ? h('div', { class: 'deviations', role: 'note' },
      h('h3', {}, 'How our version differs from the paper'),
      h('ul', {}, s.deviations.map(d => h('li', {}, d)))) : h('p', { class: 'small muted' }, 'No deviations: this benchmark is defined by construction.'),
  );
  const paramRows = Object.entries(s.params);
  const right = h('div', {},
    h('h3', {}, 'Sources'),
    s.sources.map(src => citationNode(citations.get(src.key), src.where)),
    h('h3', {}, 'Parameters'),
    paramRows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'data param-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Parameter'), h('th', { scope: 'col' }, 'Default'), h('th', { scope: 'col', class: 'txt' }, 'Source'))),
      h('tbody', {}, paramRows.map(([k, p]) => h('tr', {}, h('th', { scope: 'row', class: 'txt' }, p.label), h('td', {}, String(p.default)), h('td', { class: 'txt' }, p.source))))))
      : h('p', { class: 'small muted' }, 'None.'),
    conf.length ? [h('h3', {}, 'How well each detail is confirmed'),
      h('ul', { class: 'small' }, conf.map(c => h('li', {}, levelChip(c.level), ' ', h('b', {}, c.item), c.value && c.value !== '—' ? ` (${c.value})` : '', h('br'), h('span', { class: 'muted' }, c.where))))] : null,
    h('h3', {}, 'When it tends to fail'),
    h('ul', {}, s.failureModes.map(f => h('li', {}, f))),
  );
  const st = slot !== null ? SERIES_STYLE[slot] : null;
  return h('article', { class: 'card', id: s.id, 'aria-labelledby': s.id + '-h' },
    h('div', { class: 'card__head' },
      st ? lineKey(st.slot, st.dash) : null,
      h('h2', { id: s.id + '-h' }, s.name),
      h('div', { class: 'card__chips' },
        h('span', { class: 'chip chip--family' }, s.family),
        h('span', { class: `chip chip--evidence chip--ev-${s.evidence}` }, EVIDENCE_LABEL[s.evidence]),
        s.simulation ? h('span', { class: 'chip chip--sim' }, 'Simulation') : h('span', { class: 'chip chip--hyp' }, 'Backtests are hypothetical'))),
    h('div', { class: 'card__cols' }, left, right),
    h('p', { class: 'small' }, s.link ? h('a', { class: 'btn btn--primary', href: s.link.href }, s.link.text) : h('a', { href: 'index.html' }, 'Run it in the Showdown')));
}

async function main() {
  if (typeof katex === 'undefined') await new Promise(res => window.addEventListener('load', res, { once: true }));
  let citations = new Map();
  try { citations = await loadCitations(); } catch (e) { /* cards still render; references show as missing */ }
  const toc = clear($('#toc'));
  const all = [...STRATEGIES, AS_CARD];
  for (const s of all) toc.appendChild(h('li', {}, h('a', { href: '#' + s.id }, s.name)));
  toc.appendChild(h('li', {}, h('a', { href: '#not-shown' }, 'What we don’t show')));
  const box = clear($('#cards'));
  STRATEGIES.forEach((s, i) => box.appendChild(card(s, citations, i % SERIES_STYLE.length)));
  box.appendChild(card(AS_CARD, citations, null));
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
main();
