// Launch the real desktop app and check: it loads from app://, runs the Showdown with no errors, keeps the CSP,
// and cannot reach the network. Run: xvfb-run -a node tests/desktop/launch.spec.mjs   (needs the Electron binary,
// i.e. `npm ci` WITHOUT --ignore-scripts, and the playwright package).
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';

const userData = mkdtempSync(path.join(os.tmpdir(), 'ss-desktop-'));
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--no-sandbox'], cwd: path.resolve('.') });
try {
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(String(e)));
  win.on('console', m => { if (m.type() === 'error' && !/404|Not found/i.test(m.text())) errors.push(m.text()); });
  await win.waitForLoadState('load');
  assert.equal(new URL(win.url()).protocol, 'app:', `loaded from ${win.url()}`);
  await win.waitForFunction(() => /strateg/i.test(document.querySelector('#status-text')?.textContent || ''), null, { timeout: 30000 });
  const status = await win.textContent('#status-text');
  const canvases = await win.evaluate(() => document.querySelectorAll('canvas').length);
  assert.ok(canvases > 3, `charts rendered (${canvases})`);
  const pageErrors = [...errors]; // before the deliberate blocked-request probes below, which log CSP errors
  const csp = await win.evaluate(async () => (await fetch('index.html')).headers.get('content-security-policy'));
  assert.match(csp || '', /default-src 'self'/, 'CSP header present');
  const net = await win.evaluate(async () => { try { await fetch('https://example.com/'); return 'reached'; } catch { return 'blocked'; } });
  assert.equal(net, 'blocked', 'outbound network from the page must be blocked');
  const local = await win.evaluate(async () => (await fetch('data/local/french.json')).status);
  assert.equal(local, 404, 'no bundled French data');
  const traversal = await win.evaluate(async () => (await fetch('data/local/..%2f..%2fpackage.json')).status);
  assert.equal(traversal, 404, 'encoded traversal refused');
  const nodeAccess = await win.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined');
  assert.ok(nodeAccess, 'no Node.js in the page');
  await win.screenshot({ path: process.env.SHOT || path.join(userData, 'desktop.png') });
  assert.deepEqual(pageErrors, []);
  console.log('desktop launch OK:', status.trim());
} finally {
  await app.close();
}

// Second launch: a dataset saved in the app-data folder (as Data → Download does) is picked up automatically.
const userData2 = mkdtempSync(path.join(os.tmpdir(), 'ss-desktop-'));
mkdirSync(path.join(userData2, 'data'), { recursive: true });
copyFileSync('tests/fixtures/crosscheck-dataset.json', path.join(userData2, 'data', 'french.json'));
const app2 = await electron.launch({ args: ['.', `--user-data-dir=${userData2}`, '--no-sandbox'], cwd: path.resolve('.') });
try {
  const win = await app2.firstWindow();
  await win.waitForFunction(() => /cross-check fixture/i.test(document.body?.textContent || ''), null, { timeout: 30000 });
  const label = await win.evaluate(() => document.body.textContent.includes('Downloaded with the desktop app'));
  assert.ok(label, 'source labelled as desktop-downloaded data');
  console.log('desktop app-data dataset OK');
} finally {
  await app2.close();
}
