// Tests for docs/engine/data/ (zip reader, French CSV parser, dataset loaders, synthetic dataset).
// Fixtures: tests/fixtures/french/ — FORMAT fixtures written for tests, values invented
// (regenerate with python3 tests/fixtures/french/make_french_fixtures.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { unzip, crc32, ZipError, ZIP_LIMITS } from '../../docs/engine/data/zip.js';
import { parseFrenchCsv } from '../../docs/engine/data/french-csv.js';
import {
  FRENCH_FILES, loadFrenchFiles, fetchLocalDataset, makeSyntheticDataset, momentumReplication,
} from '../../docs/engine/data/loaders.js';
import { prepareDataset, compare } from '../../docs/engine/runner.js';
import { sha256Hex } from '../../docs/engine/hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'tests/fixtures/french');
const readFix = name => new Uint8Array(readFileSync(path.join(FIX, name)));
const fixText = name => readFileSync(path.join(FIX, name), 'latin1');
const NOW = '2026-09-30T00:00:00.000Z';
const ALL_ZIPS = ['F-F_Research_Data_Factors_CSV.zip', '12_Industry_Portfolios_CSV.zip', 'F-F_Momentum_Factor_CSV.zip', '6_Portfolios_ME_Prior_12_2_CSV.zip'];
const zipsNamed = names => names.map(name => ({ name, bytes: readFix(name) }));

// ---------- helpers: build ZIPs by hand so corrupt/hostile variants can be crafted ----------
function makeZip(entries, { flags = 0, method = null, zip64Locator = false, declaredSize = null } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data);
    const m = method ?? e.method ?? 8;
    const comp = m === 8 ? deflateRawSync(data) : data;
    const crc = crc32(new Uint8Array(data));
    const usize = declaredSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(m, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(m, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const parts = [...locals, cd];
  if (zip64Locator) { const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); parts.push(loc); }
  parts.push(eocd);
  return new Uint8Array(Buffer.concat(parts));
}

// ================================================================ zip.js
test('zip: round-trips Python-made fixture zips (deflate and stored) byte for byte', async () => {
  for (const [zipName, csvName] of [
    ['F-F_Research_Data_Factors_CSV.zip', 'F-F_Research_Data_Factors.CSV'], // deflate
    ['F-F_Momentum_Factor_CSV.zip', 'F-F_Momentum_Factor.CSV'], // stored
  ]) {
    const entries = await unzip(readFix(zipName));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, csvName);
    assert.deepEqual(Buffer.from(entries[0].bytes), readFileSync(path.join(FIX, csvName)));
  }
});

test('zip: round-trips an archive made by Python zipfile at test time (several entries, a directory)', async () => {
  const py = `import zipfile,io,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
    z.writestr('dir/', b'')
    z.writestr(zipfile.ZipInfo('dir/a.csv'), b'hello,world\\n'*500, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr(zipfile.ZipInfo('b.txt'), b'stored', compress_type=zipfile.ZIP_STORED)
sys.stdout.buffer.write(b.getvalue())`;
  let bytes;
  try { bytes = new Uint8Array(execFileSync('python3', ['-c', py])); } catch { return; } // python3 absent: fixture zips above still cover it
  const out = await unzip(bytes);
  assert.deepEqual(out.map(e => e.name), ['dir/a.csv', 'b.txt']);
  assert.equal(Buffer.from(out[0].bytes).toString(), 'hello,world\n'.repeat(500));
  assert.equal(Buffer.from(out[1].bytes).toString(), 'stored');
});

test('zip: hand-built archive with stored + deflate entries', async () => {
  const z = makeZip([{ name: 'x.csv', data: 'a,b\n1,2\n', method: 0 }, { name: 'y.csv', data: 'z'.repeat(10000), method: 8 }]);
  const out = await unzip(z);
  assert.equal(Buffer.from(out[1].bytes).toString(), 'z'.repeat(10000));
});

test('zip: rejects hostile or unsupported archives with clear errors', async () => {
  const cases = [
    [makeZip([{ name: 'a.csv', data: 'x' }], { flags: 1 }), /encrypted/],
    [makeZip([{ name: 'a.csv', data: 'x' }], { method: 12 }), /compression method 12/],
    [makeZip([{ name: 'a.csv', data: 'x' }], { zip64Locator: true }), /ZIP64/],
    [makeZip([{ name: '../evil.csv', data: 'x' }]), /"\." or "\.\."/],
    [makeZip([{ name: '/etc/passwd', data: 'x' }]), /absolute path/],
    [makeZip([{ name: 'C:/x.csv', data: 'x' }]), /absolute path/],
    [makeZip([{ name: 'a\\b.csv', data: 'x' }]), /backslash/],
    [makeZip([{ name: 'a\u0000b.csv', data: 'x' }]), /control characters/],
    [makeZip([{ name: 'a.csv', data: 'x' }, { name: 'a.csv', data: 'y' }]), /twice/],
    [makeZip([{ name: 'big.csv', data: 'x' }], { declaredSize: ZIP_LIMITS.maxTotalUncompressed + 1 }), /more than 50 MB/],
    [new Uint8Array(100), /Not a ZIP/],
    [new Uint8Array(5), /too short/],
  ];
  for (const [bytes, re] of cases) {
    await assert.rejects(unzip(bytes), err => err instanceof ZipError && re.test(err.message), String(re));
  }
});

test('zip: detects an entry that inflates beyond its declared size (bomb) and CRC corruption', async () => {
  // Declared size smaller than the real data: inflating must stop and refuse.
  const bomb = makeZip([{ name: 'a.csv', data: '0'.repeat(100000) }], { declaredSize: 1000 });
  await assert.rejects(unzip(bomb), /more data than it declares/);
  const good = makeZip([{ name: 'a.csv', data: 'hello hello hello', method: 0 }]);
  const bad = good.slice();
  bad[30 + 'a.csv'.length] ^= 0xff; // flip a data byte
  await assert.rejects(unzip(bad), /CRC-32/);
});

// ================================================================ french-csv.js
test('csv: factors file — CRLF, untitled monthly section, annual rows ignored, copyright trailer', () => {
  const p = parseFrenchCsv(fixText('F-F_Research_Data_Factors.CSV'));
  assert.equal(p.vintage, '209912');
  assert.match(p.preamble, /^This file was created by CMPT_ME_BEME_RETS/);
  assert.equal(p.sections.length, 2);
  assert.deepEqual(p.sections[0].columns, ['Mkt-RF', 'SMB', 'HML', 'RF']);
  assert.equal(p.sections[0].title, '');
  assert.equal(p.sections[0].rows.length, 39);
  assert.equal(p.sections[0].rows[0].period, '1999-10');
  assert.equal(p.sections[1].title, 'Annual Factors: January-December');
  assert.equal(p.sections[1].rows.length, 0);
  assert.equal(p.sections[1].ignoredRows, 3);
  assert.match(p.trailer, /^Copyright 2099/);
});

test('csv: multi-section industry file — titles, trailing spaces in names, -99.99 and -999 become null', () => {
  const p = parseFrenchCsv(fixText('12_Industry_Portfolios.CSV'));
  assert.deepEqual(p.sections.map(s => s.title), [
    'Average Value Weighted Returns -- Monthly', 'Average Equal Weighted Returns -- Monthly',
    'Average Value Weighted Returns -- Annual', 'Number of Firms in Portfolios', 'Average Firm Size',
  ]);
  const vw = p.sections[0];
  assert.equal(vw.columns[0], 'NoDur'); // was "NoDur  "
  assert.equal(vw.rows.length, 36);
  assert.equal(vw.rows[0].values[4], null); // -99.99
  assert.equal(p.sections[1].rows.find(r => r.period === '2001-05').values[0], null); // -999
  assert.equal(p.sections[2].rows.length, 0);
});

test('csv: small inline cases (LF vs CRLF identical, BOM, errors name the line)', () => {
  const lf = 'Header text\n\n  Title -- Monthly\n,A,B \n200001, 1.00, -99.99\n200002, 2.50,-999\n\n  Annual\n,A,B\n2000, 1, 2\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(parseFrenchCsv(lf), parseFrenchCsv(crlf));
  assert.deepEqual(parseFrenchCsv('\ufeff' + lf), parseFrenchCsv(lf));
  const p = parseFrenchCsv(lf);
  assert.deepEqual(p.sections[0].rows, [{ period: '2000-01', values: [1, null] }, { period: '2000-02', values: [2.5, null] }]);
  assert.deepEqual(p.sections[0].columns, ['A', 'B']);
  assert.throws(() => parseFrenchCsv(',A,B\n200001, 1.0\n'), /line 2: expected 2 values, found 1/);
  assert.throws(() => parseFrenchCsv(',A\n200001, abc\n'), /line 2: "abc" is not a number/);
  assert.throws(() => parseFrenchCsv(',A\n200013, 1\n'), /not a valid YYYYMM/);
  assert.throws(() => parseFrenchCsv(',A\n200002, 1\n200001, 1\n'), /out of order/);
  assert.throws(() => parseFrenchCsv('200001, 1\n'), /before any column header/);
  assert.throws(() => parseFrenchCsv(',A\n200001, 1\nsome text\n200002, 1\n'), /without a new column header/);
  assert.throws(() => parseFrenchCsv(',A,,B\n'), /empty column name/);
});

test('csv: JS and Python parsers agree on every fixture', () => {
  const csvs = readdirSync(FIX).filter(f => f.endsWith('.CSV'));
  const py = `import json,sys; sys.path.insert(0,'scripts'); import french_csv as f
out={n: f.parse_french_csv(open('tests/fixtures/french/'+n,encoding='latin-1',newline='').read()) for n in ${JSON.stringify(csvs)}}
print(json.dumps(out))`;
  let pyOut;
  try { pyOut = JSON.parse(execFileSync('python3', ['-c', py], { cwd: ROOT, maxBuffer: 64 << 20 }).toString()); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const n of csvs) assert.deepEqual(parseFrenchCsv(fixText(n)), pyOut[n], n);
});

// ================================================================ loaders.js
test('FRENCH_FILES: the four documented files under the library ftp/ folder', () => {
  assert.deepEqual(FRENCH_FILES.map(f => [f.name, f.required]), [
    ['F-F_Research_Data_Factors_CSV.zip', true], ['12_Industry_Portfolios_CSV.zip', true],
    ['F-F_Momentum_Factor_CSV.zip', false], ['6_Portfolios_ME_Prior_12_2_CSV.zip', false],
  ]);
  for (const f of FRENCH_FILES) {
    assert.equal(f.url, 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/' + f.name);
    assert.ok(f.purpose.length > 10);
  }
});

test('loadFrenchFiles: assembles the full dataset from the four zips (known answers)', async () => {
  const ds = await loadFrenchFiles(zipsNamed(ALL_ZIPS), { now: NOW });
  assert.equal(ds.schema, 1);
  assert.equal(ds.frequency, 'monthly');
  assert.equal(ds.periodsPerYear, 12);
  // Common months 2000-01..2002-12; 2000-01 has -99.99 in an industry; 2002-12 has -99.99 in Mom.
  assert.equal(ds.dates[0], '2000-02');
  assert.equal(ds.dates.at(-1), '2002-11');
  assert.equal(ds.dates.length, 34);
  assert.deepEqual(ds.provenance.alignment, {
    commonMonths: 36, missingValueMonths: 1, momentumUnavailableMonths: 1, gapTrimmedMonths: 0,
    keptMonths: 34, first: '2000-02', last: '2002-11',
  });
  assert.equal(ds.provenance.droppedMonths, 2);
  assert.deepEqual(Object.keys(ds.assets), ['NoDur', 'Durbl', 'Manuf', 'Enrgy', 'Chems', 'BusEq', 'Telcm', 'Utils', 'Shops', 'Hlth', 'Money', 'Other']);
  assert.equal(ds.assetLabels.Hlth, 'Healthcare');
  assert.deepEqual(Object.keys(ds.factors), ['MktRF', 'SMB', 'HML', 'Mom']);
  assert.equal(ds.provenance.weighting, 'value-weighted');
  assert.match(ds.provenance.attribution, /Kenneth R\. French/);
  assert.equal(ds.provenance.parsedAt, NOW);
  assert.equal(ds.provenance.files.length, 4);
  assert.equal(ds.provenance.files[0].sha256, sha256Hex(readFix('F-F_Research_Data_Factors_CSV.zip')));
  assert.deepEqual(ds.provenance.files[1].sectionsUsed, ['Average Value Weighted Returns -- Monthly']);

  // Percent -> decimal and market = Mkt-RF + RF, checked against the raw text of one month.
  const f = parseFrenchCsv(fixText('F-F_Research_Data_Factors.CSV')).sections[0].rows.find(r => r.period === '2001-06').values;
  const i = ds.dates.indexOf('2001-06');
  assert.ok(Math.abs(ds.market[i] - (f[0] + f[3]) / 100) < 1e-15);
  assert.ok(Math.abs(ds.rf[i] - f[3] / 100) < 1e-15);
  assert.ok(Math.abs(ds.factors.MktRF[i] - f[0] / 100) < 1e-15);
  const ind = parseFrenchCsv(fixText('12_Industry_Portfolios.CSV')).sections[0].rows.find(r => r.period === '2001-06').values;
  assert.ok(Math.abs(ds.assets.Money[i] - ind[10] / 100) < 1e-15);

  // The engine accepts it.
  const prepared = prepareDataset(ds);
  assert.equal(prepared.assetNames.length, 12);
});

test('loadFrenchFiles: Mom replication — fixture Mom is built exactly from the six portfolios', async () => {
  const ds = await loadFrenchFiles(zipsNamed(ALL_ZIPS), { now: NOW });
  const r = ds.replication;
  assert.equal(r.available, true);
  assert.equal(r.formula, 'Mom = ½(Small High + Big High) − ½(Small Low + Big Low)');
  assert.equal(r.months, 36); // 2000-01..2002-11 overlap = 35 plus 1999-12 (Mom has -99.99 only in 2002-12)
  assert.ok(r.maxAbsDiff < 1e-12, `maxAbsDiff ${r.maxAbsDiff}`);
  assert.ok(r.correlation > 0.999999);
  assert.equal(r.columnMapping, 'by-name');
  assert.deepEqual(r.columnsUsed, { smallLow: 'SMALL LoPRIOR', smallHigh: 'SMALL HiPRIOR', bigLow: 'BIG LoPRIOR', bigHigh: 'BIG HiPRIOR' });
});

test('momentumReplication: known answer with a planted error; positional fallback when names differ', () => {
  const rows = [];
  for (let k = 0; k < 24; k++) {
    const p = `2001-${String((k % 12) + 1).padStart(2, '0')}`.replace('2001', String(2001 + Math.floor(k / 12)));
    rows.push({ period: p, values: [k, 0, 2 * k + 1, -k, 0, 3] });
  }
  const six = { columns: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], rows };
  // Mom = ½(sh + bh) − ½(sl + bl) = ½(2k+1+3) − ½(k − k) = k + 2 ; plant +0.5 (pct) error in one month.
  const mom = { columns: ['Mom'], rows: rows.map((r, k) => ({ period: r.period, values: [k + 2 + (k === 5 ? 0.5 : 0)] })) };
  const res = momentumReplication(six, mom);
  assert.equal(res.columnMapping, 'positional');
  assert.equal(res.months, 24);
  assert.ok(Math.abs(res.maxAbsDiff - 0.005) < 1e-15);
  assert.ok(Math.abs(res.meanAbsDiff - 0.005 / 24) < 1e-15);
  assert.ok(res.correlation < 1 && res.correlation > 0.99);
  assert.equal(momentumReplication({ ...six, rows: rows.slice(0, 5) }, mom).available, false);
});

test('loadFrenchFiles: accepts bare .csv files and works without the optional files', async () => {
  const ds = await loadFrenchFiles([
    { name: 'F-F_Research_Data_Factors.CSV', bytes: readFix('F-F_Research_Data_Factors.CSV') },
    { name: '12_Industry_Portfolios.CSV', bytes: readFix('12_Industry_Portfolios.CSV') },
  ], { now: NOW });
  assert.equal(ds.dates.length, 35); // 2000-02..2002-12
  assert.equal(ds.factors.Mom, undefined);
  assert.equal(ds.replication.available, false);
  assert.match(ds.replication.reason, /momentum factor file/);
});

test('loadFrenchFiles: user-readable errors', async () => {
  await assert.rejects(loadFrenchFiles(zipsNamed(['12_Industry_Portfolios_CSV.zip'])), /Missing the Fama\/French factors file/);
  await assert.rejects(loadFrenchFiles(zipsNamed(['F-F_Research_Data_Factors_CSV.zip', 'F-F_Momentum_Factor_CSV.zip'])), /Missing an industry portfolios file/);
  await assert.rejects(loadFrenchFiles(zipsNamed(['F-F_Research_Data_Factors_CSV.zip', 'F-F_Research_Data_Factors_CSV.zip', '12_Industry_Portfolios_CSV.zip'])), /Two Fama\/French factors files/);
  await assert.rejects(loadFrenchFiles([]), /No files given/);
  await assert.rejects(loadFrenchFiles([{ name: 'notes.csv', bytes: new TextEncoder().encode('hello\n,A\n200001,1\n') }, ...zipsNamed(['F-F_Research_Data_Factors_CSV.zip'])]), /notes\.csv: not one of the supported files/);
  await assert.rejects(loadFrenchFiles([{ name: 'x.zip', bytes: new Uint8Array([1, 2, 3]) }]), /not a valid ZIP/);
  const fiveFactor = ',Mkt-RF,SMB,HML,RMW,CMA,RF\n200001,1,1,1,1,1,1\n';
  await assert.rejects(loadFrenchFiles([{ name: 'F-F_Research_Data_5_Factors_2x3.csv', bytes: new TextEncoder().encode(fiveFactor) }]), /5-factor file/);
  const annualOnly = 'x\n,Mkt-RF,SMB,HML,RF\n2000,1,1,1,1\n';
  await assert.rejects(loadFrenchFiles([{ name: 'F-F_Research_Data_Factors.CSV', bytes: new TextEncoder().encode(annualOnly) }]), /no monthly rows/);
  const bad = 'This file\n\n,Mkt-RF,SMB,HML,RF\n200001, 1, x, 1, 1\n';
  await assert.rejects(loadFrenchFiles([{ name: 'F-F_Research_Data_Factors.CSV', bytes: new TextEncoder().encode(bad) }]), /F-F_Research_Data_Factors\.CSV: French CSV line 4/);
});

test('loadFrenchFiles: agrees exactly with the Python assembly (scripts/french_csv.py)', async () => {
  const js = await loadFrenchFiles(zipsNamed(ALL_ZIPS), { now: NOW });
  const py = `import json,sys; sys.path.insert(0,'scripts'); import french_csv as f
from pathlib import Path
d=Path('tests/fixtures/french'); names=${JSON.stringify(ALL_ZIPS)}
print(json.dumps(f.load_french_files([(n,(d/n).read_bytes()) for n in names], now='${NOW}')))`;
  let out;
  try { out = execFileSync('python3', ['-c', py], { cwd: ROOT, maxBuffer: 64 << 20 }).toString(); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const pyDs = JSON.parse(out);
  const close = (a, b, where) => {
    if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) <= 1e-15 * Math.max(1, Math.abs(a)), `${where}: ${a} vs ${b}`); return; }
    if (Array.isArray(a)) { assert.equal(a.length, b.length, where); a.forEach((x, i) => close(x, b[i], `${where}[${i}]`)); return; }
    if (a && typeof a === 'object') { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), where); for (const k of Object.keys(a)) close(a[k], b[k], `${where}.${k}`); return; }
    assert.equal(a, b, where);
  };
  close(js, pyDs, 'dataset');
});

test('fetchLocalDataset: null on 404 or network error, dataset on 200', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    assert.equal(await fetchLocalDataset(), null);
    globalThis.fetch = async () => { throw new TypeError('network'); };
    assert.equal(await fetchLocalDataset(), null);
    let seenUrl;
    globalThis.fetch = async url => { seenUrl = url; return new Response(JSON.stringify({ schema: 1, dates: ['2000-01'] }), { status: 200 }); };
    assert.deepEqual(await fetchLocalDataset(), { schema: 1, dates: ['2000-01'] });
    assert.equal(seenUrl, 'data/local/french.json');
    globalThis.fetch = async () => new Response('{"schema":2}', { status: 200 });
    await assert.rejects(fetchLocalDataset('x.json'), /not a schema-1 dataset/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ================================================================ synthetic
test('makeSyntheticDataset: labelled, deterministic, valid, 1950-01..2019-12', () => {
  const a = makeSyntheticDataset();
  const b = makeSyntheticDataset(7);
  assert.equal(sha256Hex(JSON.stringify(a)), sha256Hex(JSON.stringify(b)));
  assert.notDeepEqual(makeSyntheticDataset(8).market, a.market);
  assert.equal(a.synthetic, true);
  assert.equal(a.id, 'synthetic-demo');
  assert.match(a.title, /SYNTHETIC — not market data/);
  assert.match(a.provenance.note, /noise/);
  assert.equal(a.dates[0], '1950-01');
  assert.equal(a.dates.at(-1), '2019-12');
  assert.equal(a.dates.length, 70 * 12);
  assert.equal(Object.keys(a.assets).length, 12);
  assert.deepEqual(Object.keys(a.factors), ['MktRF', 'SMB', 'HML', 'Mom']);
  const p = prepareDataset(a);
  assert.equal(p.fingerprint, prepareDataset(makeSyntheticDataset(7)).fingerprint);
});

test('makeSyntheticDataset: statistics match the documented model (no planted anomaly)', () => {
  const ds = makeSyntheticDataset();
  const T = ds.dates.length;
  const ex = ds.market.map((m, i) => m - ds.rf[i]);
  const mean = ex.reduce((s, x) => s + x, 0) / T;
  const sd = Math.sqrt(ex.reduce((s, x) => s + (x - mean) ** 2, 0) / (T - 1));
  assert.ok(Math.abs(mean - 0.005) < 4 * 0.043 / Math.sqrt(T), `mean ${mean}`);
  assert.ok(Math.abs(sd - 0.043) < 0.004, `sd ${sd}`);
  // Lag-1 autocorrelation of each asset's excess return is small (no built-in momentum/reversal).
  for (const [name, r] of Object.entries(ds.assets)) {
    const x = r.map((v, i) => v - ds.rf[i]);
    const m = x.reduce((s, v) => s + v, 0) / T;
    let num = 0, den = 0;
    for (let i = 0; i < T; i++) den += (x[i] - m) ** 2;
    for (let i = 1; i < T; i++) num += (x[i] - m) * (x[i - 1] - m);
    assert.ok(Math.abs(num / den) < 4 / Math.sqrt(T), `${name} autocorr ${num / den}`);
  }
});

test('makeSyntheticDataset: runs end-to-end through compare()', () => {
  const res = compare(makeSyntheticDataset(), [{ id: 'buy-hold-market' }, { id: 'equal-weight' }]);
  assert.equal(res.dataset.synthetic, true);
  assert.equal(res.runs.length, 2);
});
