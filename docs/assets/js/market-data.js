// One market series for the "How markets move", "Market timing" and "Terminal" pages, from one of three sources:
//   synthetic  random numbers (always available; no built-in patterns besides a positive average return)
//   french     the user's local copy of the Kenneth R. French data (market = Mkt−RF + RF; cash = RF; month-end)
//   shiller    Robert Shiller's S&P Composite 1871–2023 (local copy, or fetched on request from a pinned commit;
//              monthly AVERAGE prices; no short rate, so cash = 0%)
import { fetchLocalDataset, makeSyntheticDataset } from '../../engine/data/loaders.js';
import { loadShiller, SHILLER_SOURCE } from '../../engine/data/shiller.js';
import { $, h, clear } from './common.js';

const KEY = 'ss-market-source';

export function fromSynthetic() {
  const ds = makeSyntheticDataset(7);
  return {
    id: 'synthetic', title: 'Synthetic market (random numbers, seed 7)', dates: ds.dates, ret: ds.market, cash: ds.rf, cape: null,
    priceType: 'synthetic', synthetic: true,
    caveats: ['Random numbers from a documented model: normal monthly returns with a positive average. Not market data; no fat tails or volatility clustering by construction.'],
  };
}

export function fromFrench(ds) {
  return {
    id: 'french', title: `US stock market (French Data Library, local copy), ${ds.dates[0]} to ${ds.dates[ds.dates.length - 1]}`,
    dates: ds.dates, ret: ds.market, cash: ds.rf, cape: null, priceType: 'month-end', synthetic: false,
    caveats: ['Value-weighted US market total return (Mkt−RF + RF), month-end to month-end.', 'Cash earns the 1-month T-bill rate (RF).', 'Your own local copy; never published by this site.'],
  };
}

export function fromShiller(sh, source) {
  return {
    id: 'shiller', title: `S&P Composite (Robert Shiller), ${sh.dates[1]} to ${sh.dates[sh.dates.length - 1]}`,
    dates: sh.dates.slice(1), ret: sh.ret.slice(1), cash: new Array(sh.dates.length - 1).fill(0), cape: sh.cape.slice(1),
    priceType: 'monthly average', synthetic: false,
    caveats: [
      'Shiller’s notes describe the prices as monthly AVERAGES of daily closing prices (the note written for his book covers the data through January 2000), not month-end prices. Averaging smooths returns and adds positive autocorrelation even to a pure random walk (Working 1960), which flatters trend-following timing rules.',
      'There is no short-term interest rate in these data, so cash earns 0%: this understates any rule that holds cash.',
      'Dividends and earnings are S&P four-quarter totals (before 1926: annual Cowles data) interpolated to months.',
      source === 'local' ? 'Loaded from your local copy.' : `Fetched from GitHub (${SHILLER_SOURCE.repo}, commit ${SHILLER_SOURCE.commit.slice(0, 7)}), SHA-256 checked; not stored by this site.`,
    ],
  };
}

/**
 * Render a source picker into `root` and call onChange(series) whenever a series is ready.
 * French appears only if a local copy exists. Shiller loads a local copy if present, else fetches on click.
 */
export async function initMarketPicker(root, onChange, setStatus = () => {}) {
  let french = null;
  try { const ds = await fetchLocalDataset(); if (ds && !ds.synthetic) french = ds; } catch { /* none */ }
  const opts = [
    { id: 'synthetic', label: 'Synthetic' },
    ...(french ? [{ id: 'french', label: 'US market (French, your copy)' }] : []),
    { id: 'shiller', label: 'S&P since 1871 (Shiller)' },
  ];
  const caveatBox = h('ul', { class: 'small caveats' });
  const titleEl = h('p', { class: 'small' });
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Market data' },
    opts.map(o => h('button', { type: 'button', 'data-src': o.id, 'aria-pressed': 'false', onclick: () => choose(o.id) }, o.label)));
  clear(root).append(group, titleEl, caveatBox);

  async function choose(id) {
    for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.src === id));
    try { sessionStorage.setItem(KEY, id); } catch { /* storage blocked */ }
    let series;
    try {
      if (id === 'french') series = fromFrench(french);
      else if (id === 'shiller') {
        setStatus('running', 'Loading Shiller data…');
        const r = await loadShiller();
        series = fromShiller(r.data, r.source);
      } else series = fromSynthetic();
    } catch (err) {
      setStatus('error', `Could not load: ${err.message}`);
      return;
    }
    titleEl.textContent = series.title;
    clear(caveatBox).append(...series.caveats.map(c => h('li', {}, c)));
    onChange(series);
  }

  let start = 'synthetic';
  try { const s = sessionStorage.getItem(KEY); if (s && opts.some(o => o.id === s)) start = s; } catch { /* storage blocked */ }
  if (start === 'synthetic' && french) start = 'french';
  await choose(start);
  return { choose };
}
