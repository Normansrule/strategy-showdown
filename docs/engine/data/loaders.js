// Dataset loaders. Zero dependencies; browsers and Node 22.
//
// Kenneth R. French Data Library files are NEVER committed to the repository or deployed with the site: the
// library publishes no licence, so redistribution rights are unclear. Users obtain the files themselves:
//   (a) `python scripts/fetch_french.py` writes docs/data/local/french.json (gitignored), read by fetchLocalDataset();
//   (b) they download the zips and drop them on the page; loadFrenchFiles() parses them in the browser.
//       Nothing is uploaded anywhere.
// makeSyntheticDataset() gives everyone a clearly labelled, random dataset to try the mechanics.
//
// The Python twin of loadFrenchFiles() is scripts/french_csv.py (assemble_dataset); both are tested on the
// same fixtures in tests/fixtures/french/.

import { unzip } from './zip.js';
import { parseFrenchCsv } from './french-csv.js';
import { sha256Hex } from '../hash.js';
import { makeRng } from '../mathx.js';

export const FRENCH_BASE_URL = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/';
export const FRENCH_LIBRARY_URL = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html';

// File names and URLs as linked from the Data Library page (checked 2026-09-30).
export const FRENCH_FILES = [
  {
    name: 'F-F_Research_Data_Factors_CSV.zip',
    url: FRENCH_BASE_URL + 'F-F_Research_Data_Factors_CSV.zip',
    required: true,
    purpose: 'Fama/French 3 factors, monthly: Mkt-RF, SMB, HML and the 1-month T-bill return RF.',
  },
  {
    name: '12_Industry_Portfolios_CSV.zip',
    url: FRENCH_BASE_URL + '12_Industry_Portfolios_CSV.zip',
    required: true,
    purpose: 'Asset universe: the value-weighted monthly returns of 12 industry portfolios. Other N_Industry_Portfolios files (5, 10, 17, 30, 38, 48, 49) are accepted instead.',
  },
  {
    name: 'F-F_Momentum_Factor_CSV.zip',
    url: FRENCH_BASE_URL + 'F-F_Momentum_Factor_CSV.zip',
    required: false,
    purpose: 'Momentum factor Mom (optional), used in factor attribution.',
  },
  {
    name: '6_Portfolios_ME_Prior_12_2_CSV.zip',
    url: FRENCH_BASE_URL + '6_Portfolios_ME_Prior_12_2_CSV.zip',
    required: false,
    purpose: 'Six size/prior-return portfolios (optional): used only to rebuild Mom and check it against the published series.',
  },
];

export const ATTRIBUTION = 'Data: Kenneth R. French Data Library (Tuck School of Business, Dartmouth). The library publishes no licence; the data are not redistributed by this project and are used with attribution.';

// Descriptive labels for the 12-industry codes (our shorthand for the codes used in the file headers).
export const INDUSTRY_LABELS = {
  NoDur: 'Consumer non-durables', Durbl: 'Consumer durables', Manuf: 'Manufacturing', Enrgy: 'Energy',
  Chems: 'Chemicals', BusEq: 'Business equipment', Telcm: 'Telecom', Utils: 'Utilities',
  Shops: 'Retail & wholesale', Hlth: 'Healthcare', Money: 'Finance', Other: 'Other',
  HiTec: 'High technology',
};

export const MOM_REPLICATION_FORMULA = 'Mom = ½(Small High + Big High) − ½(Small Low + Big Low)';
// Six-portfolio header seen in a copy of the real file: SMALL LoPRIOR, ME1 PRIOR2, SMALL HiPRIOR, BIG LoPRIOR, ME2 PRIOR2, BIG HiPRIOR.
const SIX_BY_NAME = { smallLow: 'SMALL LoPRIOR', smallHigh: 'SMALL HiPRIOR', bigLow: 'BIG LoPRIOR', bigHigh: 'BIG HiPRIOR' };
// Positional fallback, if a vintage renames the columns: order is small (low, mid, high), big (low, mid, high).
const SIX_BY_POSITION = { smallLow: 0, smallHigh: 2, bigLow: 3, bigHigh: 5 };

const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
const sameCols = (a, b) => a.length === b.length && a.every((c, i) => norm(c) === norm(b[i]));

function monthlySections(parsed) {
  return parsed.sections.filter(s => s.rows.length > 0);
}

function findSection(parsed, pred, what, fileName) {
  const s = monthlySections(parsed).find(pred);
  if (!s) throw new Error(`${fileName}: could not find the ${what} section with monthly rows.`);
  return s;
}

/** Work out what a parsed file is. Returns {kind, section, ...}. */
export function classifyFrenchFile(fileName, parsed) {
  const base = fileName.split('/').pop();
  const pre = parsed.preamble.toLowerCase();
  const all = parsed.sections;
  if (all.length === 0) throw new Error(`${base}: no column header found; this does not look like a Kenneth R. French Data Library CSV file.`);
  if (monthlySections(parsed).length === 0) {
    throw new Error(`${base}: no monthly rows (YYYYMM) found. Daily, weekly and annual-only files are not supported; use the monthly file.`);
  }
  const first = all[0].columns.map(norm);

  if (first.includes('mkt-rf')) {
    if (first.includes('rmw') || first.includes('cma')) {
      throw new Error(`${base}: this is the 5-factor file. Use F-F_Research_Data_Factors (3 factors), whose SMB is the one the engine expects.`);
    }
    const section = findSection(parsed, s => sameCols(s.columns, ['Mkt-RF', 'SMB', 'HML', 'RF']), 'Mkt-RF, SMB, HML, RF', base);
    return { kind: 'factors', section };
  }
  if (all.every(s => s.columns.length === 1) && /^(mom|umd)$/.test(first[0])) {
    return { kind: 'momentum', section: findSection(parsed, s => /^(mom|umd)$/.test(norm(s.columns[0])), 'Mom', base) };
  }
  const industryN = /(\d+)_industry_portfolios/i.exec(base)?.[1] || /returns for (\d+) industry portfolios/i.exec(pre)?.[1];
  if (industryN || /industry portfolios/.test(pre)) {
    if (/_daily|_weekly/i.test(base)) throw new Error(`${base}: daily/weekly files are not supported; use the monthly file.`);
    const section = findSection(parsed, s => /value\s*weight/i.test(s.title) && /monthly/i.test(s.title), '"Average Value Weighted Returns -- Monthly"', base);
    if (industryN && section.columns.length !== Number(industryN)) {
      throw new Error(`${base}: expected ${industryN} industry columns, found ${section.columns.length}.`);
    }
    return { kind: 'industry', section, nIndustries: section.columns.length };
  }
  const isSix = /6_portfolios_me_prior_12_2/i.test(base) || (/prior/.test(pre) && /-12 to\s*-\s*2/.test(pre) && all[0].columns.length === 6);
  if (isSix) {
    const section = findSection(parsed, s => /value\s*weight/i.test(s.title) && /monthly/i.test(s.title), '"Average Value Weighted Returns -- Monthly"', base);
    if (section.columns.length !== 6) throw new Error(`${base}: expected 6 portfolio columns, found ${section.columns.length}.`);
    return { kind: 'sizeMomentum6', section };
  }
  throw new Error(`${base}: not one of the supported files (${FRENCH_FILES.map(f => f.name.replace('_CSV.zip', '')).join(', ')}, or another N_Industry_Portfolios file).`);
}

const decoder = () => new TextDecoder('utf-8'); // French files are ASCII; stray bytes become U+FFFD in text lines only

async function expandInputs(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('No files given. Add the Fama/French factors file and an industry portfolios file.');
  if (files.length > 20) throw new Error('Too many files (at most 20).');
  const out = [];
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) throw new Error('Each file must be {name, bytes: Uint8Array}.');
    const sha256 = sha256Hex(f.bytes);
    const isZip = f.bytes.length >= 4 && f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && f.bytes[2] === 0x03 && f.bytes[3] === 0x04;
    if (isZip) {
      const entries = (await unzip(f.bytes)).filter(e => /\.csv$/i.test(e.name));
      if (entries.length === 0) throw new Error(`${f.name}: the ZIP contains no .csv file.`);
      for (const e of entries) out.push({ name: f.name, entry: e.name, sha256, size: f.bytes.length, text: decoder().decode(e.bytes) });
    } else if (/\.(csv|txt)$/i.test(f.name) || !/\.zip$/i.test(f.name)) {
      out.push({ name: f.name, entry: null, sha256, size: f.bytes.length, text: decoder().decode(f.bytes) });
    } else {
      throw new Error(`${f.name}: not a valid ZIP file.`);
    }
  }
  return out;
}

const KIND_LABEL = {
  factors: 'Fama/French factors file', industry: 'industry portfolios file',
  momentum: 'momentum factor file', sizeMomentum6: '6 size/momentum portfolios file',
};

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}

/** Rebuild Mom from the six portfolios and compare with the published series. Inputs in percent. */
export function momentumReplication(six, mom) {
  let mapping = 'by-name';
  const idx = {};
  for (const [k, col] of Object.entries(SIX_BY_NAME)) idx[k] = six.columns.findIndex(c => norm(c) === norm(col));
  if (Object.values(idx).some(i => i < 0)) {
    mapping = 'positional';
    Object.assign(idx, SIX_BY_POSITION);
  }
  const momBy = new Map(mom.rows.map(r => [r.period, r.values[0]]));
  const rebuilt = [], published = [];
  for (const r of six.rows) {
    const p = momBy.get(r.period);
    const v = [r.values[idx.smallLow], r.values[idx.smallHigh], r.values[idx.bigLow], r.values[idx.bigHigh]];
    if (p === undefined || p === null || v.some(x => x === null)) continue;
    rebuilt.push((0.5 * (v[1] + v[3]) - 0.5 * (v[0] + v[2])) / 100);
    published.push(p / 100);
  }
  if (rebuilt.length < 12) return { available: false, reason: 'Fewer than 12 overlapping months between the six portfolios and Mom.' };
  let maxAbsDiff = 0, sumAbs = 0;
  for (let i = 0; i < rebuilt.length; i++) {
    const d = Math.abs(rebuilt[i] - published[i]);
    if (d > maxAbsDiff) maxAbsDiff = d;
    sumAbs += d;
  }
  return {
    available: true,
    formula: MOM_REPLICATION_FORMULA,
    source: 'French library momentum factor page (det_mom_factor.html)',
    months: rebuilt.length,
    maxAbsDiff,
    meanAbsDiff: sumAbs / rebuilt.length,
    correlation: pearson(rebuilt, published),
    columnMapping: mapping,
    headerUsed: six.columns.slice(),
    columnsUsed: { smallLow: six.columns[idx.smallLow], smallHigh: six.columns[idx.smallHigh], bigLow: six.columns[idx.bigLow], bigHigh: six.columns[idx.bigHigh] },
    units: 'decimal returns (0.0001 = 0.01 percentage points)',
    roundingNote: 'The library prints returns to 2 decimals of a percent, so rounding alone can explain differences up to 0.00015 (4 inputs × ½ × 0.00005 + 0.00005).',
  };
}

function nextMonth(p) {
  let y = Number(p.slice(0, 4)), m = Number(p.slice(5)) + 1;
  if (m === 13) { m = 1; y++; }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

/**
 * Assemble a dataset (docs/ENGINE_SPEC.md §1) from already-parsed files.
 * @param {Array<{name, entry, sha256, size, parsed}>} items
 * @param {{now?: string}} options  now = ISO timestamp for provenance.parsedAt (tests pass a fixed value)
 */
export function assembleFrenchDataset(items, options = {}) {
  const byKind = {};
  for (const it of items) {
    const c = classifyFrenchFile(it.entry || it.name, it.parsed);
    if (byKind[c.kind]) throw new Error(`Two ${KIND_LABEL[c.kind]}s were given (${byKind[c.kind].item.name} and ${it.name}). Add only one.`);
    byKind[c.kind] = { ...c, item: it };
  }
  if (!byKind.factors) throw new Error('Missing the Fama/French factors file (F-F_Research_Data_Factors_CSV.zip).');
  if (!byKind.industry) throw new Error('Missing an industry portfolios file (e.g. 12_Industry_Portfolios_CSV.zip).');

  const F = byKind.factors.section, I = byKind.industry.section, M = byKind.momentum?.section;
  const fBy = new Map(F.rows.map(r => [r.period, r.values]));
  const iBy = new Map(I.rows.map(r => [r.period, r.values]));
  const mBy = M ? new Map(M.rows.map(r => [r.period, r.values[0]])) : null;

  // 1. Months present in every required file.
  const common = F.rows.map(r => r.period).filter(p => iBy.has(p));
  if (common.length === 0) throw new Error('The factors file and the industry file have no months in common.');
  // 2. Drop months where a required value is missing (-99.99 / -999).
  const complete = common.filter(p => !fBy.get(p).some(v => v === null) && !iBy.get(p).some(v => v === null));
  const missingValueMonths = common.length - complete.length;
  // 3. Mom (optional) must be present too, or the factor attribution would have holes.
  const withMom = mBy ? complete.filter(p => mBy.get(p) !== undefined && mBy.get(p) !== null) : complete;
  const momentumUnavailableMonths = complete.length - withMom.length;
  // 4. Keep the longest run of consecutive calendar months (latest run on ties): strategies assume no gaps.
  let best = [], run = [];
  for (const p of withMom) {
    if (run.length && nextMonth(run[run.length - 1]) !== p) run = [];
    run.push(p);
    if (run.length >= best.length) best = run.slice();
  }
  const gapTrimmedMonths = withMom.length - best.length;
  if (best.length < 24) throw new Error(`Only ${best.length} complete consecutive months after aligning the files; at least 24 are needed.`);

  const dates = best;
  const col = (by, j) => dates.map(p => by.get(p)[j] / 100);
  const fc = name => F.columns.findIndex(c => norm(c) === norm(name));
  const rf = col(fBy, fc('RF'));
  const mktrf = col(fBy, fc('Mkt-RF'));
  const market = dates.map(p => (fBy.get(p)[fc('Mkt-RF')] + fBy.get(p)[fc('RF')]) / 100);
  const assets = {}, assetLabels = {};
  I.columns.forEach((name, j) => {
    if (assets[name]) throw new Error(`Industry file has the column ${name} twice.`);
    assets[name] = col(iBy, j);
    assetLabels[name] = INDUSTRY_LABELS[name] || name;
  });
  const factors = { MktRF: mktrf, SMB: col(fBy, fc('SMB')), HML: col(fBy, fc('HML')) };
  if (mBy) factors.Mom = dates.map(p => mBy.get(p) / 100);

  const fileRecord = (k, sectionsUsed, columns) => {
    const it = byKind[k].item;
    return { name: it.name, entry: it.entry, sha256: it.sha256, bytes: it.size, kind: k, crspVintage: it.parsed.vintage, sectionsUsed, columns };
  };
  const files = [
    fileRecord('factors', [F.title || '(first, untitled monthly section)'], F.columns),
    fileRecord('industry', [I.title], I.columns),
  ];
  if (M) files.push(fileRecord('momentum', [M.title || '(first, untitled monthly section)'], M.columns));
  let replication = { available: false, reason: 'Needs both the momentum factor file and the 6 size/momentum portfolios file.' };
  if (byKind.sizeMomentum6) {
    files.push(fileRecord('sizeMomentum6', [byKind.sizeMomentum6.section.title], byKind.sizeMomentum6.section.columns));
    if (M) replication = momentumReplication(byKind.sizeMomentum6.section, M);
  }

  const vintages = [...new Set(files.map(f => f.crspVintage).filter(Boolean))];
  const N = I.columns.length;
  const vintageLabel = vintages.length === 1 ? `CRSP ${vintages[0]} vintage` : vintages.length ? `mixed CRSP vintages ${vintages.join(', ')}` : 'vintage not stated in files';
  return {
    schema: 1,
    id: `french-${N}ind-${vintages.length === 1 ? vintages[0] : 'user'}`,
    title: `US stock market, ${N} industries (Kenneth R. French Data Library, ${vintageLabel})`,
    frequency: 'monthly',
    periodsPerYear: 12,
    units: 'decimal simple returns',
    dates, rf, market, assets, assetLabels, factors,
    replication,
    provenance: {
      origin: `Kenneth R. French Data Library, ${FRENCH_LIBRARY_URL}`,
      files,
      parsedAt: options.now || new Date().toISOString(),
      weighting: 'value-weighted',
      market: 'Market = Mkt-RF + RF (value-weighted return of CRSP firms listed on NYSE, AMEX or NASDAQ).',
      alignment: {
        commonMonths: common.length, missingValueMonths, momentumUnavailableMonths, gapTrimmedMonths,
        keptMonths: dates.length, first: dates[0], last: dates[dates.length - 1],
      },
      droppedMonths: common.length - dates.length,
      vintageNote: 'French revises past returns when CRSP data are updated, so results depend on the download date. The CRSP vintage is read from each file\'s first line.' + (vintages.length > 1 ? ' WARNING: the files come from different vintages; download them on the same day.' : ''),
      attribution: ATTRIBUTION,
    },
  };
}

/**
 * Parse user-supplied French library files (.zip or .csv) into a dataset.
 * @param {Array<{name: string, bytes: Uint8Array}>} files
 * @param {{now?: string}} [options]
 */
export async function loadFrenchFiles(files, options = {}) {
  const expanded = await expandInputs(files);
  const items = expanded.map(e => {
    let parsed;
    try { parsed = parseFrenchCsv(e.text); } catch (err) { throw new Error(`${e.entry || e.name}: ${err.message}`); }
    return { ...e, text: undefined, parsed };
  });
  return assembleFrenchDataset(items, options);
}

/** Read the locally built dataset (scripts/fetch_french.py or scripts/build_snapshot.py). null if absent. */
export async function fetchLocalDataset(url = 'data/local/french.json') {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return null; // offline, file:// or blocked
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }
  if (!data || data.schema !== 1 || !Array.isArray(data.dates)) throw new Error(`${url} is not a schema-1 dataset.`);
  return data;
}

const SYN_START = 1950, SYN_END = 2019;
const round6 = x => Math.round(x * 1e6) / 1e6;

/**
 * Deterministic SYNTHETIC dataset for trying the mechanics. Random numbers, not market data, no planted anomalies.
 * Model (monthly):  rf = max(0, 0.003 + 0.001·z)
 *                   e_m = 0.005 + 0.043·z                 (market excess return)
 *                   market = rf + e_m
 *                   asset_j = rf + β_j·e_m + 0.03·z_j,     β_j = 0.6 … 1.4 evenly spaced (12 assets)
 *                   factors: MktRF = e_m; SMB, HML, Mom = 0.03·z (independent noise)
 * z are independent standard normals from makeRng(seed). Assets differ only in beta, so any strategy "edge"
 * seen on this dataset is noise (or leverage on the market premium).
 */
export function makeSyntheticDataset(seed = 7) {
  const rng = makeRng(seed);
  const dates = [];
  for (let y = SYN_START; y <= SYN_END; y++) for (let m = 1; m <= 12; m++) dates.push(`${y}-${String(m).padStart(2, '0')}`);
  const T = dates.length;
  const names = 'ABCDEFGHIJKL'.split('');
  const betas = names.map((_, j) => 0.6 + (0.8 * j) / (names.length - 1));
  const rf = [], market = [], em = [];
  const assets = Object.fromEntries(names.map(n => [`Syn${n}`, []]));
  const factors = { MktRF: [], SMB: [], HML: [], Mom: [] };
  for (let t = 0; t < T; t++) {
    const r = Math.max(0, 0.003 + 0.001 * rng.normal());
    const e = 0.005 + 0.043 * rng.normal();
    rf.push(round6(r)); em.push(e); market.push(round6(r + e));
    names.forEach((n, j) => assets[`Syn${n}`].push(round6(r + betas[j] * e + 0.03 * rng.normal())));
    factors.MktRF.push(round6(e));
    factors.SMB.push(round6(0.03 * rng.normal()));
    factors.HML.push(round6(0.03 * rng.normal()));
    factors.Mom.push(round6(0.03 * rng.normal()));
  }
  const assetLabels = Object.fromEntries(names.map((n, j) => [`Syn${n}`, `Synthetic industry ${n} (β = ${betas[j].toFixed(2)})`]));
  return {
    schema: 1,
    id: 'synthetic-demo',
    title: 'SYNTHETIC — not market data (random numbers for trying the tool)',
    synthetic: true,
    frequency: 'monthly',
    periodsPerYear: 12,
    units: 'decimal simple returns',
    dates, rf, market, assets, assetLabels, factors,
    provenance: {
      origin: 'Generated in your browser by makeSyntheticDataset() in docs/engine/data/loaders.js',
      seed,
      model: 'rf = max(0, 0.3% + 0.1%·z); market excess = 0.5% + 4.3%·z; asset_j = rf + β_j·(market excess) + 3%·z_j with β from 0.6 to 1.4; SMB, HML, Mom = 3%·z (pure noise). z = independent standard normals.',
      note: 'SYNTHETIC DATA. These are random numbers, not market history. No anomaly (momentum, reversal, trend) was built in, so any strategy that appears to beat the market here is showing noise or extra market exposure, not skill.',
      parsedAt: null,
    },
  };
}
