// Strategy Showdown desktop app (Electron main process).
//
// Same code as the website: the window loads docs/ unchanged. What the desktop adds:
//   • works offline, nothing to host;
//   • one menu command downloads the Kenneth R. French Data Library files the user asks for, parses them with the
//     SAME engine code the browser uses (docs/engine/data/loaders.js), and saves the dataset in this computer's
//     app-data folder. The data never leave the computer and are never bundled with the app.
//
// Security model (docs/SECURITY_MODEL.md, "Desktop app"):
//   • the page runs sandboxed with contextIsolation, no Node.js, no preload script and no IPC: it cannot touch the
//     file system or the network beyond its own read-only app:// origin;
//   • every request that is not app://showdown is cancelled; no localhost server, no open port;
//   • the page's own Content Security Policy is sent as a response header on every app:// response;
//   • new windows are refused; https links open in the system browser; navigation away from app:// is refused;
//   • all permission requests (camera, notifications, …) are denied;
//   • the only outbound requests are the French library downloads, made by the main process, to an allowlist of
//     exact URLs, after the user confirms, with a size cap.
import { app, BrowserWindow, Menu, dialog, protocol, session, shell } from 'electron';
import { promises as fsp, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIME, pageCsp, securityHeaders } from '../server.mjs';
import { SCHEME, HOST, START_URL, mapAppUrl, isAllowedRequest, isExternalLinkAllowed, isFrenchDownloadUrl } from './routes.mjs';
import { FRENCH_FILES, FRENCH_LIBRARY_URL, loadFrenchFiles } from '../../docs/engine/data/loaders.js';
import { SHILLER_SOURCE, parseShillerCsv } from '../../docs/engine/data/shiller.js';
import { sha256Hex } from '../../docs/engine/hash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(HERE, '..', '..', 'docs');
const REPO_URL = 'https://github.com/Normansrule/strategy-showdown';
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // each French zip is well under 1 MB today

const dataRoot = () => path.join(app.getPath('userData'), 'data');
const datasetPath = () => path.join(dataRoot(), 'french.json');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
const headers = securityHeaders(pageCsp(DOCS_ROOT));

async function handleAppRequest(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers });
  const file = mapAppUrl(request.url, { docsRoot: DOCS_ROOT, dataRoot: dataRoot() });
  if (!file) return new Response('Not found', { status: 404, headers });
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return new Response('Not found', { status: 404, headers });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file));
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': type, 'Content-Length': String(st.size) } });
  } catch {
    return new Response('Not found', { status: 404, headers });
  }
}

function lockDownSession(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedRequest(details.url) }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    title: 'Strategy Showdown',
    backgroundColor: '#f7f8fa',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkAllowed(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${SCHEME}://${HOST}/`)) return;
    event.preventDefault();
    if (isExternalLinkAllowed(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.loadURL(START_URL);
}

async function downloadFrenchData() {
  const list = FRENCH_FILES.map(f => `• ${f.name}${f.required ? '' : ' (optional)'}`).join('\n');
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Download', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Download data',
    message: 'Download monthly data from the Kenneth R. French Data Library?',
    detail: `These files are fetched from ${FRENCH_LIBRARY_URL.replace(/data_library\.html$/, '')} and saved only on this computer:\n\n${list}\n\nThe library publishes no licence, so the data are for your own use and are never bundled with this app or uploaded anywhere.`,
  });
  if (response !== 0) return;
  const files = [];
  const failed = [];
  for (const f of FRENCH_FILES) {
    if (!isFrenchDownloadUrl(f.url, FRENCH_FILES)) continue;
    try {
      // A separate in-memory session: the window's session cancels every non-app:// request.
      const res = await session.fromPartition('french-downloads').fetch(f.url, { bypassCustomProtocolHandlers: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!new URL(res.url || f.url).href.startsWith(new URL(f.url).origin + '/')) throw new Error('redirected to another site');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('file larger than expected');
      files.push({ name: f.name, bytes: buf });
    } catch (err) {
      if (f.required) failed.push(`${f.name}: ${err.message}`);
    }
  }
  if (failed.length) {
    dialog.showErrorBox('Download failed', `${failed.join('\n')}\n\nYou can also download the zips yourself from the Data Library page and drop them on the Showdown page.`);
    return;
  }
  try {
    const dataset = await loadFrenchFiles(files);
    dataset.provenance = { ...(dataset.provenance || {}), downloadedBy: 'Strategy Showdown desktop app', downloadedAt: new Date().toISOString() };
    await fsp.mkdir(dataRoot(), { recursive: true });
    await fsp.writeFile(datasetPath(), JSON.stringify(dataset));
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Data saved on this computer.', detail: datasetPath() });
    mainWindow.webContents.reloadIgnoringCache();
  } catch (err) {
    dialog.showErrorBox('Could not read the downloaded files', err.message);
  }
}

async function downloadShillerData() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Download', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Download data',
    message: 'Download Robert Shiller’s monthly S&P Composite data (1871–2023)?',
    detail: `From the open-data package ${SHILLER_SOURCE.repo} on GitHub, pinned to commit ${SHILLER_SOURCE.commit.slice(0, 7)} and checked against its SHA-256. Saved only on this computer.\n\n${SHILLER_SOURCE.licence}`,
  });
  if (response !== 0) return;
  try {
    const res = await session.fromPartition('french-downloads').fetch(SHILLER_SOURCE.url, { bypassCustomProtocolHandlers: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('file larger than expected');
    if (sha256Hex(bytes) !== SHILLER_SOURCE.sha256) throw new Error('the file does not match the pinned SHA-256');
    parseShillerCsv(new TextDecoder().decode(bytes)); // refuse anything that does not parse
    await fsp.mkdir(dataRoot(), { recursive: true });
    await fsp.writeFile(path.join(dataRoot(), 'shiller.csv'), bytes);
    await dialog.showMessageBox(mainWindow, { type: 'info', message: 'Shiller data saved on this computer.', detail: path.join(dataRoot(), 'shiller.csv') });
    mainWindow.webContents.reloadIgnoringCache();
  } catch (err) {
    dialog.showErrorBox('Download failed', err.message);
  }
}

async function removeFrenchData() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Remove all downloaded data (French and Shiller) from this computer?',
  });
  if (response !== 0) return;
  await fsp.rm(datasetPath(), { force: true });
  await fsp.rm(path.join(dataRoot(), 'shiller.csv'), { force: true });
  mainWindow.webContents.reloadIgnoringCache();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Data',
      submenu: [
        { label: 'Download French Data Library files…', click: () => downloadFrenchData() },
        { label: 'Download Shiller S&P Composite data…', click: () => downloadShillerData() },
        { label: 'Show data folder', click: async () => { await fsp.mkdir(dataRoot(), { recursive: true }); shell.openPath(dataRoot()); } },
        { label: 'Remove downloaded data…', click: () => removeFrenchData() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Disclaimer', click: () => mainWindow?.loadURL(`${SCHEME}://${HOST}/disclaimer.html`) },
        { label: 'Sources', click: () => mainWindow?.loadURL(`${SCHEME}://${HOST}/sources.html`) },
        { type: 'separator' },
        { label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.whenReady().then(() => {
  lockDownSession(session.defaultSession);
  protocol.handle(SCHEME, handleAppRequest);
  buildMenu();
  createWindow();
});
