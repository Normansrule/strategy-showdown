// Robert J. Shiller's monthly US stock market data (S&P Composite, 1871–2023), as tidied by the open-data
// package datasets/s-and-p-500 on GitHub. NOT bundled with this project: the original has no explicit licence
// (the packager dedicates its own work under ODC-PDDL-1.0), so users fetch it themselves — the web page fetches
// one pinned commit on request, the desktop app's Data menu saves a copy, and scripts/fetch_shiller.py writes
// docs/data/local/shiller.csv. Details: docs/ENGINE_SPEC.md §10.
//
// Important properties of these data (stated on every page that uses them):
//   • Shiller's notes describe prices as monthly averages of daily closing prices (in the text written for his
//     book, through January 2000); averaging smooths returns and creates positive first-order autocorrelation
//     even in a pure random walk (Working 1960);
//   • dividends and earnings: since 1926, S&P four-quarter totals linearly interpolated to months; before 1926,
//     annual Cowles data interpolated;
//   • there is no short-term interest rate, so "cash" earns 0% nominal in anything built on this dataset.
import { sha256Hex } from '../hash.js';

export const SHILLER_SOURCE = Object.freeze({
  repo: 'datasets/s-and-p-500',
  commit: '07b81e6af68239acd65b901a11844d6d95db6ead',
  path: 'data/data.csv',
  url: 'https://raw.githubusercontent.com/datasets/s-and-p-500/07b81e6af68239acd65b901a11844d6d95db6ead/data/data.csv',
  sha256: '3a45dffabc414afc298c12159abc84c2875f88175ff3d4473ef7417e725ecac6',
  lastShillerMonth: '2023-06',
  origin: 'Robert J. Shiller, online data for Irrational Exuberance (http://www.econ.yale.edu/~shiller/data.htm)',
  licence: 'Original: no explicit licence. Packaging: ODC-PDDL-1.0 (datasets/s-and-p-500). Not redistributed by this project.',
});
export const SHILLER_LOCAL_URL = 'data/local/shiller.csv';
export const MAX_SHILLER_CHARS = 2 * 1024 * 1024;

const HEADER = ['Date', 'SP500', 'Dividend', 'Earnings', 'Consumer Price Index', 'Long Interest Rate', 'Real Price', 'Real Dividend', 'Real Earnings', 'PE10'];

/**
 * Parse the CSV into monthly series. Rows after the last month with real Shiller data (where the packager fills
 * dividends, earnings and CPI with 0) are dropped; CAPE (PE10) of 0 is treated as missing (null).
 * Returns { dates, price, dividend, earnings, cpi, longRate, cape, ret, priceRet, realRet } where ret[t] is the
 * total return from month t−1 to t: (P_t + D_t/12)/P_{t−1} − 1 (Shiller's convention), ret[0] = null.
 */
export function parseShillerCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_SHILLER_CHARS) throw new Error('Not a Shiller CSV (empty or too large).');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  const head = lines[0].split(',').map(s => s.trim());
  if (HEADER.some((h, i) => head[i] !== h)) throw new Error(`Unexpected columns: ${head.join(', ')}`);
  const out = { dates: [], price: [], dividend: [], earnings: [], cpi: [], longRate: [], cape: [] };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length !== HEADER.length) throw new Error(`Row ${i + 1}: expected ${HEADER.length} fields.`);
    const date = c[0].trim();
    if (!/^\d{4}-\d{2}-01$/.test(date)) throw new Error(`Row ${i + 1}: bad date ${date}`);
    const v = c.slice(1).map(Number);
    if (v.some(x => !Number.isFinite(x))) throw new Error(`Row ${i + 1}: non-numeric value.`);
    const [price, div, earn, cpi, lr, , , , pe10] = v;
    if (!(cpi > 0 && div > 0 && earn !== 0)) break; // end of the Shiller-sourced rows
    if (!(price > 0)) throw new Error(`Row ${i + 1}: non-positive price.`);
    out.dates.push(date.slice(0, 7));
    out.price.push(price); out.dividend.push(div); out.earnings.push(earn); out.cpi.push(cpi); out.longRate.push(lr);
    out.cape.push(pe10 > 0 ? pe10 : null);
  }
  const n = out.dates.length;
  if (n < 120) throw new Error('Fewer than 10 years of usable rows.');
  for (let t = 1; t < n; t++) if (out.dates[t] <= out.dates[t - 1]) throw new Error(`Dates not increasing at ${out.dates[t]}.`);
  out.ret = [null]; out.priceRet = [null]; out.realRet = [null];
  for (let t = 1; t < n; t++) {
    const r = (out.price[t] + out.dividend[t] / 12) / out.price[t - 1] - 1;
    out.ret.push(r);
    out.priceRet.push(out.price[t] / out.price[t - 1] - 1);
    out.realRet.push((1 + r) * out.cpi[t - 1] / out.cpi[t] - 1);
  }
  return out;
}

/** Fetch the pinned file (or a local copy) and check its SHA-256 when it is the pinned remote file. */
export async function loadShiller({ preferLocal = true, fetchImpl = fetch } = {}) {
  const tryUrl = async (url, check) => {
    const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_SHILLER_CHARS) throw new Error('Shiller file larger than expected.');
    const hash = sha256Hex(bytes);
    if (check && hash !== SHILLER_SOURCE.sha256) throw new Error(`Downloaded file does not match the pinned SHA-256 (${hash.slice(0, 12)}…).`);
    return { data: parseShillerCsv(new TextDecoder().decode(bytes)), sha256: hash, url };
  };
  if (preferLocal) {
    try { const r = await tryUrl(SHILLER_LOCAL_URL, false); if (r) return { ...r, source: 'local' }; } catch { /* fall through */ }
  }
  const r = await tryUrl(SHILLER_SOURCE.url, true);
  if (!r) throw new Error('Could not download the Shiller data.');
  return { ...r, source: 'remote' };
}

/** As an engine dataset (schema 1): Market = S&P Composite total return; rf = 0 (no short rate in the data). */
export function shillerToDataset(sh) {
  return {
    schema: 1, id: 'shiller-sp-composite', title: `S&P Composite (Shiller), ${sh.dates[1]} to ${sh.dates[sh.dates.length - 1]}`,
    frequency: 'monthly', periodsPerYear: 12, units: 'decimal',
    dates: sh.dates.slice(1), rf: new Array(sh.dates.length - 1).fill(0), market: sh.ret.slice(1),
    assets: {}, assetLabels: {}, factors: null,
    provenance: { origin: SHILLER_SOURCE.origin, via: `${SHILLER_SOURCE.repo}@${SHILLER_SOURCE.commit.slice(0, 7)}`, licence: SHILLER_SOURCE.licence,
      caveats: ['Prices are monthly averages of daily closes per Shiller’s notes (not month-end).', 'No short-term rate: cash earns 0%.', 'Dividends and earnings are four-quarter (pre-1926: annual) totals interpolated to months.'] },
  };
}
