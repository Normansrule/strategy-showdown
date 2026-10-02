// Tests for desktop/server.mjs: spawns the real server and talks to it over loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import { resolveSafe, createServer, DEFAULT_CSP } from '../../desktop/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function request(port, pathAndQuery, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // Raw path is sent verbatim (no client-side normalisation of ../ or %2e).
    const req = http.request({ host: '127.0.0.1', port, method, path: pathAndQuery, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startSpawned() {
  const child = spawn(process.execPath, [path.join(ROOT, 'desktop/server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 30000);
    child.stdout.on('data', d => {
      out += d;
      const m = /Open: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/.exec(out);
      if (m) { clearTimeout(timer); resolve(m); }
    });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { child, port: Number(url[2]), token: url[3] };
}

test('spawned server: loopback only, token -> cookie -> 200, 403 otherwise, headers everywhere', async t => {
  const { child, port, token } = await startSpawned();
  t.after(() => child.kill());
  assert.equal(token.length, 32); // 24 random bytes, base64url

  // No token, no cookie
  const denied = await request(port, '/');
  assert.equal(denied.status, 403);
  for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy', 'x-frame-options']) {
    assert.ok(denied.headers[h], `403 has ${h}`);
  }
  assert.equal((await request(port, '/?token=wrong')).status, 403);
  assert.equal((await request(port, '/engine/hash.js', { headers: { Cookie: 'ss_session=nope' } })).status, 403);

  // Valid token: cookie + redirect to the clean URL
  const first = await request(port, `/?token=${token}`);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/');
  const setCookie = first.headers['set-cookie'][0];
  assert.match(setCookie, /^ss_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  const withQuery = await request(port, `/engine/hash.js?x=1&token=${token}`);
  assert.equal(withQuery.headers.location, '/engine/hash.js?x=1');
  const cookie = setCookie.split(';')[0];

  // With cookie: files served with correct types and security headers
  const js = await request(port, '/engine/hash.js', { headers: { Cookie: cookie } });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.match(js.body, /sha256Hex/);
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  assert.equal(js.headers['referrer-policy'], 'no-referrer');
  assert.equal(js.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(js.headers['x-frame-options'], 'DENY');
  assert.match(js.headers['content-security-policy'], /default-src 'self'/);
  assert.match(js.headers['content-security-policy'], /frame-ancestors 'none'/);
  const json = await request(port, '/data/citations.json', { headers: { Cookie: cookie } });
  assert.equal(json.headers['content-type'], 'application/json; charset=utf-8');
  const head = await request(port, '/data/citations.json', { method: 'HEAD', headers: { Cookie: cookie } });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(json.body));

  // Methods, directories, traversal
  assert.equal((await request(port, '/engine/hash.js', { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  assert.equal((await request(port, '/engine/hash.js', { method: 'PUT', headers: { Cookie: cookie } })).status, 405);
  const dir = await request(port, '/engine', { headers: { Cookie: cookie } });
  assert.equal(dir.status, 301);
  assert.equal((await request(port, '/engine/', { headers: { Cookie: cookie } })).status, 404); // no listing
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/engine/%2e%2e/%2e%2e/package.json', '/..%2fpackage.json',
    '/..%5cpackage.json', '/engine/hash.js%00.png', '/%00', '/..\\package.json', '/.gitignore', '//etc/passwd', '/%zz']) {
    const r = await request(port, p, { headers: { Cookie: cookie } });
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /"name": "strategy-showdown"|root:/);
  }

  // DNS rebinding: a foreign Host header is refused even with the cookie
  const rebinding = await request(port, '/engine/hash.js', { headers: { Cookie: cookie, Host: `evil.example:${port}` } });
  assert.equal(rebinding.status, 403);
  assert.equal((await request(port, '/engine/hash.js', { headers: { Cookie: cookie, Host: `localhost:${port}` } })).status, 200);
});

test('server binds to 127.0.0.1 only', async t => {
  const { server, listen } = createServer({ token: 'x'.repeat(32) });
  await listen();
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
});

test('symlinks that escape the served folder are refused', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ss-srv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'site');
  mkdirSync(root);
  writeFileSync(path.join(dir, 'secret.txt'), 'SECRET');
  writeFileSync(path.join(root, 'ok.txt'), 'fine');
  try { symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'link.txt')); } catch { return; } // no symlink permission
  const token = 't'.repeat(32);
  const { server, listen, csp } = createServer({ root, token });
  const port = await listen();
  t.after(() => server.close());
  assert.equal(csp, DEFAULT_CSP); // no index.html -> default policy
  const cookie = `ss_session=${token}`;
  assert.equal((await request(port, '/ok.txt', { headers: { Cookie: cookie } })).body, 'fine');
  const r = await request(port, '/link.txt', { headers: { Cookie: cookie } });
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /SECRET/);
});

test('CSP is read from docs/index.html when present', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ss-csp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:">`);
  const { csp } = createServer({ root: dir, token: 'x'.repeat(32) });
  assert.equal(csp, "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
});

test('resolveSafe: pure path checks', () => {
  const root = '/srv/site';
  assert.equal(resolveSafe(root, '/a/b.js'), '/srv/site/a/b.js');
  assert.equal(resolveSafe(root, '/'), '/srv/site');
  assert.equal(resolveSafe(root, '/a%20b.js'), '/srv/site/a b.js');
  for (const bad of ['/../x', '/a/../../x', '/%2e%2e/x', '/a%2fb', '/a%5cb', '/a%00', '/a\\b', '/.env', 'relative', '/%E0%A4%A']) {
    assert.equal(resolveSafe(root, bad), null, bad);
  }
});
