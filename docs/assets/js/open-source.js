// Open-source terminals and tools page: renders docs/data/open-source.json (licences read from each repository).
import { $, h, clear, initPage } from './common.js';

initPage();

const PERMISSIVE = /^(MIT|BSD-\d-Clause|Apache-2\.0)$/;
const COPYLEFT = /^(A?GPL|LGPL)-/;
const kind = lic => (PERMISSIVE.test(lic) ? 'permissive' : COPYLEFT.test(lic) ? 'copyleft' : 'custom');
const KIND_LABEL = { permissive: 'Permissive', copyleft: 'Copyleft', custom: 'Custom terms' };
const safeUrl = u => (/^https:\/\//.test(u || '') ? u : null);

function licenceCell(lic) {
  const k = kind(lic);
  return h('td', { class: 'txt' }, h('span', { class: `chip chip--lic-${k}` }, KIND_LABEL[k]), ' ', h('span', { class: 'lic' }, lic.replace(/^Custom: /, '')));
}

function link(t) {
  const u = safeUrl(t.url);
  return u ? h('a', { href: u, rel: 'noopener noreferrer' }, t.name) : t.name;
}

function renderBloomberg(tools) {
  const bbg = tools.filter(t => t.bloomberg_project);
  const sdk = bbg.find(t => !t.repo);
  const finance = bbg.filter(t => t.repo && ['charting', 'analytics'].includes(t.category));
  const dev = bbg.filter(t => t.repo && !['charting', 'analytics'].includes(t.category));
  const item = t => h('li', {}, h('b', {}, link(t)), ` (${t.license}): ${t.description}`);
  clear($('#bbg')).append(
    h('p', { class: 'prose' }, 'The Bloomberg Terminal itself is proprietary, subscription software. Bloomberg does, however, publish several open-source projects on GitHub under its own organization:'),
    h('h3', {}, 'Useful for finance work in Python notebooks'), h('ul', { class: 'prose' }, finance.map(item)),
    h('h3', {}, 'General developer tools'), h('ul', { class: 'prose' }, dev.map(item)),
    sdk ? h('div', { class: 'callout callout--caution' },
      h('p', {}, h('b', {}, `${sdk.name}. `), sdk.description),
      h('p', {}, 'Not open source. The Python package is published under a custom Bloomberg licence (the conda-forge recipe records it as LicenseRef-Bloomberg-BLPAPI), and it comes without data: Bloomberg’s own blpapi-node README says it requires a Desktop API, Server API or B-PIPE subscription. We could not read Bloomberg’s official page from our build environment, so check the current terms there: ',
        h('a', { href: safeUrl(sdk.url), rel: 'noopener noreferrer' }, 'Bloomberg API library'), '.')) : null,
    h('p', { class: 'small muted' }, 'This project is not affiliated with Bloomberg L.P. “Bloomberg” and “Bloomberg Terminal” are trademarks of their owner and are used here only to identify their products.'),
  );
}

function renderTable(data, cat) {
  const rows = data.tools.filter(t => t.repo && !t.bloomberg_project && (!cat || t.category === cat))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  clear($('#oss-table')).appendChild(h('table', { class: 'data oss' },
    h('caption', { class: 'visually-hidden' }, 'Open-source market software with licences'),
    h('thead', {}, h('tr', {}, ['Project', 'Category', 'What it is', 'Licence', 'Last commit', 'Notes'].map((c, i) => h('th', { scope: 'col', class: [0, 1, 2, 3, 5].includes(i) ? 'txt' : '' }, c)))),
    h('tbody', {}, rows.map(t => h('tr', {},
      h('th', { scope: 'row', class: 'txt' }, link(t), h('span', { class: 'sub' }, t.repo)),
      h('td', { class: 'txt' }, t.category),
      h('td', { class: 'txt desc' }, t.description),
      licenceCell(t.license),
      h('td', {}, t.latest_commit_date || '—'),
      h('td', { class: 'txt desc small' }, t.caveats || ''))))));
}

async function boot() {
  const data = await fetch('data/open-source.json', { credentials: 'same-origin' }).then(r => r.json());
  $('#oss-sub').textContent = `${data.note} Checked ${data.checked}.`;
  renderBloomberg(data.tools);
  const sel = $('#oss-cat');
  for (const c of [...new Set(data.tools.filter(t => t.repo && !t.bloomberg_project).map(t => t.category))].sort()) sel.appendChild(h('option', { value: c }, c));
  sel.addEventListener('change', () => renderTable(data, sel.value));
  renderTable(data, '');
}
boot().catch(err => { $('#oss-table').textContent = 'Could not load the list: ' + err.message; });
