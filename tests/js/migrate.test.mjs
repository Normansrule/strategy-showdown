// v0.4.0 rename: one-time copy of downloaded data from the pre-rename app folder (desktop/electron/migrate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyData, LEGACY_APP_DIRS, MARKER } from '../../desktop/electron/migrate.mjs';

const NEW = 'Trading Floor Strategy Showdown';

function sandbox() {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-migrate-'));
  return { appData, userData: path.join(appData, NEW), cleanup: () => fs.rmSync(appData, { recursive: true, force: true }) };
}
function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }

test('copies the legacy data folder once, byte for byte, and leaves the source untouched', (t) => {
  const s = sandbox(); t.after(s.cleanup);
  const old = path.join(s.appData, LEGACY_APP_DIRS[0], 'data');
  write(path.join(old, 'french.json'), '{"x":1}');
  write(path.join(old, 'shiller.csv'), 'Date,P\n1871.01,4.44\n');
  write(path.join(old, 'nested', 'ü ñ.txt'), 'non-ASCII and spaces');

  const r = migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData, now: () => 'T' });
  assert.equal(r.status, 'migrated');
  assert.deepEqual([...r.files].sort(), ['french.json', path.join('nested', 'ü ñ.txt'), 'shiller.csv'].sort());
  for (const f of r.files) assert.deepEqual(fs.readFileSync(path.join(s.userData, 'data', f)), fs.readFileSync(path.join(old, f)));
  assert.ok(fs.existsSync(path.join(old, 'french.json')), 'source kept');
  const marker = JSON.parse(fs.readFileSync(path.join(s.userData, MARKER), 'utf8'));
  assert.equal(marker.at, 'T');
  assert.equal(Object.keys(marker.files).length, 3);
  assert.match(marker.files['french.json'], /^[0-9a-f]{64}$/);

  // Second launch: the new folder exists, so nothing happens.
  assert.equal(migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData }).status, 'skipped-new-exists');
});

test('never overwrites: an existing new data folder wins', (t) => {
  const s = sandbox(); t.after(s.cleanup);
  write(path.join(s.appData, LEGACY_APP_DIRS[0], 'data', 'french.json'), 'old');
  write(path.join(s.userData, 'data', 'french.json'), 'new');
  assert.equal(migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData }).status, 'skipped-new-exists');
  assert.equal(fs.readFileSync(path.join(s.userData, 'data', 'french.json'), 'utf8'), 'new');
});

test('no legacy folder: no-op, nothing created', (t) => {
  const s = sandbox(); t.after(s.cleanup);
  assert.equal(migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData }).status, 'skipped-no-legacy');
  assert.equal(fs.existsSync(path.join(s.userData, 'data')), false);
});

test('falls back to the development folder name when the installed one is absent', (t) => {
  const s = sandbox(); t.after(s.cleanup);
  write(path.join(s.appData, LEGACY_APP_DIRS[1], 'data', 'french.json'), 'dev');
  const r = migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData });
  assert.equal(r.status, 'migrated');
  assert.equal(r.from, path.join(s.appData, LEGACY_APP_DIRS[1]));
});

test('a failed or corrupted copy removes only what it created and reports the error', (t) => {
  const s = sandbox(); t.after(s.cleanup);
  const old = path.join(s.appData, LEGACY_APP_DIRS[0], 'data');
  write(path.join(old, 'a.json'), 'a');
  write(path.join(old, 'c', 'd.json'), 'd');
  // Simulate a copy that silently corrupts the second file: the SHA-256 check must catch it.
  let n = 0;
  const corrupting = (from, to, mode) => { fs.copyFileSync(from, to, mode); if (++n === 2) fs.appendFileSync(to, 'x'); };
  const r = migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData, copyFile: corrupting });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /hash mismatch/);
  assert.equal(fs.existsSync(path.join(s.userData, 'data')), false);
  assert.equal(fs.existsSync(path.join(s.userData, MARKER)), false);
  assert.equal(fs.readFileSync(path.join(old, 'a.json'), 'utf8'), 'a', 'source kept');
  assert.equal(fs.readFileSync(path.join(old, 'c', 'd.json'), 'utf8'), 'd', 'source kept');

  // A copy that throws (disk full, permissions) is handled the same way.
  const throwing = () => { throw new Error('ENOSPC: no space left on device'); };
  const r2 = migrateLegacyData({ appDataDir: s.appData, userDataDir: s.userData, copyFile: throwing });
  assert.equal(r2.status, 'failed');
  assert.match(r2.error, /ENOSPC/);
  assert.equal(fs.existsSync(path.join(s.userData, 'data')), false);
});
