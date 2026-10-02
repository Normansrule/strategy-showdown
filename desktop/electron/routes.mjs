// Pure helpers for the desktop app (no Electron import, so they are unit-tested with plain Node).
//
// The desktop window loads the SAME files as the website, from docs/, over a private app:// scheme:
//   app://showdown/<path>            → <docs>/<path>            (read-only, bundled with the app)
//   app://showdown/data/local/<f>    → <userData>/data/<f>      (the user's own French data, never bundled)
// Everything else (http, https, file, ws …) is blocked by the main process. Paths are resolved with the same
// traversal/dotfile rules as the local web server (desktop/server.mjs → resolveSafe).
import path from 'node:path';
import { resolveSafe } from '../server.mjs';

export const SCHEME = 'app';
export const HOST = 'showdown';
export const ORIGIN = `${SCHEME}://${HOST}`;
export const START_URL = `${ORIGIN}/index.html`;
export const LOCAL_DATA_PREFIX = '/data/local/';

/**
 * Map an app:// URL to a file on disk, or null (→ 404).
 * @param {string} url
 * @param {{docsRoot: string, dataRoot: string}} roots
 */
export function mapAppUrl(url, { docsRoot, dataRoot }) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return null;
  let p = u.pathname || '/';
  if (p === '/') p = '/index.html';
  if (p.startsWith(LOCAL_DATA_PREFIX)) {
    return resolveSafe(path.resolve(dataRoot), '/' + p.slice(LOCAL_DATA_PREFIX.length));
  }
  if (p === '/data/local') return null;
  return resolveSafe(path.resolve(docsRoot), p);
}

/** Requests the window may make: its own app:// origin, plus inline data:/blob: URLs created by the page. */
export function isAllowedRequest(url) {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (url.startsWith('devtools:') || url.startsWith('chrome-extension:')) return true; // only reachable with devtools open
  try { const u = new URL(url); return u.protocol === `${SCHEME}:` && u.host === HOST; } catch { return false; }
}

/** Links the user clicks that may open in the system browser: plain https only (sources, DOIs, the repo). */
export function isExternalLinkAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}

/** The only URLs the desktop app ever downloads, and only when the user asks: the French library zips. */
export function isFrenchDownloadUrl(url, frenchFiles) {
  return frenchFiles.some(f => f.url === url);
}
