// Sources page: filterable bibliography + confirmation-level table.
import { $, h, clear, initPage, loadCitations, authorsFull } from './common.js';
import { CONFIRMATION, LEVELS, GROUP_LABEL } from './confirmation.js';

initPage();

const VERIF = { crossref: 'Checked against Crossref', publisher: 'Checked against the publisher page' };

function entry(c) {
  const doiUrl = c.doi ? 'https://doi.org/' + c.doi : null;
  const vol = [c.volume ? c.volume : '', c.issue ? `(${c.issue})` : ''].join('');
  const tail = [c.journal ? h('i', {}, c.journal) : null, vol ? ' ' + vol : '', c.pages ? `, ${c.pages}` : ''];
  return h('li', { id: 'ref-' + c.key },
    h('div', { class: 'bib__cite' },
      authorsFull(c) || c.publisher || '', ` (${c.year ?? 'n.d.'}). `, h('b', {}, c.title), '. ', tail, c.journal ? '.' : ''),
    h('div', { class: 'bib__meta' },
      h('span', { class: `chip ${c.verification === 'crossref' ? 'chip--level-paper' : 'chip--level-publisher'}` }, VERIF[c.verification] || c.verification || 'unchecked'),
      doiUrl ? h('a', { href: doiUrl, rel: 'noopener noreferrer' }, 'doi:' + c.doi) : null,
      c.url && (!doiUrl || c.url !== doiUrl) ? h('a', { href: c.url, rel: 'noopener noreferrer' }, doiUrl ? 'publisher page' : 'link') : null,
      h('span', { class: 'bib__key' }, 'key: ' + c.key)),
    c.notes ? h('p', { class: 'bib__notes' }, c.notes) : null);
}

function firstFamily(c) { return ((c.authors || [])[0]?.family || c.publisher || c.title || '').toLowerCase(); }

async function main() {
  let list = [];
  try { list = [...(await loadCitations()).values()]; } catch (err) { clear($('#bib')).appendChild(h('li', { class: 'error-box' }, 'Could not load citations.json: ' + err.message)); }
  const draw = () => {
    const q = $('#bib-filter').value.trim().toLowerCase();
    const v = $('#bib-verif').value;
    const sort = $('#bib-sort').value;
    let rows = list.filter(c => (!v || c.verification === v) && (!q || JSON.stringify([c.key, c.title, c.journal, c.year, (c.authors || []).map(a => a.family)]).toLowerCase().includes(q)));
    const cmp = {
      author: (a, b) => firstFamily(a).localeCompare(firstFamily(b)) || (a.year || 0) - (b.year || 0),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      'year-asc': (a, b) => (a.year || 0) - (b.year || 0),
      journal: (a, b) => (a.journal || '~').localeCompare(b.journal || '~'),
    }[sort];
    rows = rows.sort(cmp);
    const ol = clear($('#bib'));
    rows.forEach(c => ol.appendChild(entry(c)));
    $('#bib-count').textContent = `${rows.length} of ${list.length} references`;
  };
  ['#bib-filter', '#bib-sort', '#bib-verif'].forEach(s => $(s).addEventListener('input', draw));
  draw();

  const drawConf = () => {
    const lv = $('#conf-level').value;
    const rows = CONFIRMATION.filter(c => !lv || c.level === lv);
    const t = clear($('#conf-table'));
    t.append(h('caption', { class: 'visually-hidden' }, 'Confirmation level of each parameter'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Where used'), h('th', { scope: 'col', class: 'txt' }, 'Detail'), h('th', { scope: 'col', class: 'txt' }, 'Value'), h('th', { scope: 'col', class: 'txt' }, 'Confirmed by'), h('th', { scope: 'col', class: 'txt' }, 'Where it was checked'))),
      h('tbody', {}, rows.map(c => h('tr', {},
        h('td', { class: 'txt' }, c.group === 'metrics' ? h('a', { href: 'metrics.html' }, GROUP_LABEL[c.group]) : c.group === 'overfitting' ? h('a', { href: 'overfitting.html' }, GROUP_LABEL[c.group]) : c.group === 'models' ? h('a', { href: 'markets.html' }, GROUP_LABEL[c.group]) : c.group === 'timing' ? h('a', { href: 'timing.html' }, GROUP_LABEL[c.group]) : c.group === 'execution' ? h('a', { href: 'atlas.html#execution' }, GROUP_LABEL[c.group]) : h('a', { href: 'strategies.html#' + c.group }, GROUP_LABEL[c.group])),
        h('td', { class: 'txt' }, c.item), h('td', { class: 'txt' }, c.value),
        h('td', { class: 'txt' }, h('span', { class: `chip chip--level-${c.level}`, title: LEVELS[c.level].explain }, LEVELS[c.level].label)),
        h('td', { class: 'txt' }, c.where)))));
    const counts = Object.keys(LEVELS).map(k => `${CONFIRMATION.filter(c => c.level === k).length} ${LEVELS[k].label.toLowerCase()}`).join(' · ');
    $('#conf-count').textContent = counts;
  };
  $('#conf-level').addEventListener('input', drawConf);
  drawConf();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
main();
