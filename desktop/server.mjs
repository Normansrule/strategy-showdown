#!/usr/bin/env node
// Desktop mode: serve docs/ to THIS computer only.   npm run serve [-- --open] [-- --port 8123]
//
// - Binds to 127.0.0.1 (loopback) only, on a random free port unless --port is given.
// - A random per-session token (crypto.randomBytes(24)) is printed in the URL. The first request carrying a valid
//   ?token= gets an HttpOnly, SameSite=Strict cookie and is redirected to the clean URL. Anything without a valid
//   cookie or token gets 403, so other local users, other sites in your browser and DNS-rebinding pages cannot
//   read the app (the Host header is also checked).
// - GET/HEAD only; static files only; no directory listings; dotfiles hidden; path traversal and symlink
//   escapes rejected; security headers on every response, using the same CSP as the pages.
// - Node built-ins only. It makes no outbound network requests.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp, readFileSync, existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', 'docs');
const COOKIE = 'ss_session';

// Used when docs/index.html has no CSP meta tag. Keep in step with the pages' own policy.
export const DEFAULT_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

/** Read the CSP from the pages' <meta http-equiv="Content-Security-Policy"> so both stay identical. */
export function pageCsp(root) {
  let csp = DEFAULT_CSP;
  try {
    const html = readFileSync(path.join(root, 'index.html'), 'utf8');
    const m = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]+)"|'([^']+)')/i.exec(html)
      || /<meta\s+content=(?:"([^"]+)"|'([^']+)')\s+http-equiv=["']Content-Security-Policy["']/i.exec(html);
    if (m) csp = (m[1] || m[2]).trim().replace(/;\s*$/, '');
  } catch { /* no index.html yet */ }
  // frame-ancestors is ignored in <meta>, so make sure the header carries it.
  if (!/frame-ancestors/.test(csp)) csp += "; frame-ancestors 'none'";
  return csp;
}

export function securityHeaders(csp) {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Map a raw request path to a file inside root, or null if it is unsafe. Pure string checks, then realpath. */
export function resolveSafe(root, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  if (/%(00|2f|5c)/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some(s => s === '..' || s === '.' || s.startsWith('.'))) return null; // traversal and dotfiles
  const full = path.resolve(root, ...segments);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

export function createServer({ root = DEFAULT_ROOT, token, port = 0 } = {}) {
  root = path.resolve(root);
  const realRootPromise = fsp.realpath(root);
  const csp = pageCsp(root);
  const base = securityHeaders(csp);
  let allowedHosts = new Set();

  const send = (req, res, status, body = '', headers = {}) => {
    const buf = Buffer.from(body);
    res.writeHead(status, { ...base, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has((req.headers.host || '').toLowerCase())) return send(req, res, 403, 'Forbidden: unexpected Host header.\n');
      if (!req.url || !req.url.startsWith('/')) return send(req, res, 400, 'Bad request.\n');
      const q = req.url.indexOf('?');
      const rawPath = q < 0 ? req.url : req.url.slice(0, q);
      const params = new URLSearchParams(q < 0 ? '' : req.url.slice(q + 1));

      const cookieOk = safeEqual(cookieValue(req.headers.cookie, COOKIE), token);
      if (params.has('token')) {
        if (!safeEqual(params.get('token'), token)) return send(req, res, 403, 'Forbidden: invalid token. Use the link printed by `npm run serve`.\n');
        params.delete('token');
        const rest = params.toString();
        return send(req, res, 303, '', {
          Location: rawPath + (rest ? '?' + rest : ''),
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!cookieOk) return send(req, res, 403, 'Forbidden: open the link printed by `npm run serve` (it contains a one-session token).\n');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });

      const file = resolveSafe(root, rawPath);
      if (!file) return send(req, res, 404, 'Not found.\n');
      const realRoot = await realRootPromise;
      let target = file;
      let st;
      try {
        const real = await fsp.realpath(file);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return send(req, res, 404, 'Not found.\n'); // symlink escape
        target = real;
        st = await fsp.stat(target);
        if (st.isDirectory()) {
          if (!rawPath.endsWith('/')) return send(req, res, 301, '', { Location: rawPath + '/' });
          target = path.join(target, 'index.html');
          st = await fsp.stat(target); // no directory listings: index.html or 404
        }
      } catch {
        return send(req, res, 404, 'Not found.\n');
      }
      if (!st.isFile()) return send(req, res, 404, 'Not found.\n');
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { ...base, 'Content-Type': type, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(target);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) send(req, res, 500, 'Internal error.\n');
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
      resolve(p);
    });
  });
  return { server, listen, csp };
}

function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else {
    let wsl = false;
    try { wsl = /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { /* not Linux */ }
    cmd = wsl && existsSync('/usr/bin/wslview') ? 'wslview' : 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Could not open a browser automatically (${cmd}); copy the link above.`));
    child.unref();
  } catch {
    console.log('Could not open a browser automatically; copy the link above.');
  }
}

function parseArgs(argv) {
  const out = { open: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port needs a number from 1 to 65535 (got ${v}).`);
      out.port = n;
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown option ${a}. Use --open and/or --port N.`);
  }
  return out;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) {
    console.log('Usage: npm run serve [-- --open] [-- --port N]\nServes docs/ on 127.0.0.1 only, behind a one-session token.');
    return;
  }
  const token = randomBytes(24).toString('base64url');
  const { server, listen } = createServer({ token, port: opts.port });
  let port;
  try { port = await listen(); } catch (e) { console.error(`Could not start the server: ${e.message}`); process.exit(1); }
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  const local = existsSync(path.join(DEFAULT_ROOT, 'data', 'local', 'french.json'));
  console.log('Strategy Showdown (desktop mode) — only this computer can connect.');
  console.log(`Open: ${url}`);
  console.log(local
    ? 'Local French dataset found: docs/data/local/french.json'
    : 'No local dataset yet. Run `python scripts/fetch_french.py`, or use the synthetic demo / drop files on the page.');
  console.log('Press Ctrl+C to stop.');
  if (opts.open) openBrowser(url);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
