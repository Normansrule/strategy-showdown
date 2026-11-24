// One-time copy of the user's downloaded data from the app's pre-rename data folder (v0.4.0 rename).
//
// Electron names the per-user data folder after the app: packaged builds use productName, `npm run desktop` uses the
// package name. Renaming "Strategy Showdown" to "Trading Floor Strategy Showdown" therefore gives the app a new, empty
// folder. This copies <old>/data/ (the French and Shiller files the user downloaded) into <new>/data/.
//
// Rules: copy, never move or delete; never overwrite (if the new data folder exists, nothing happens); verify every
// copied file by SHA-256 against its source; on any mismatch remove only what this run copied and report it. The
// theme preference (Chromium Local Storage) is not copied: it is a cosmetic setting and copying a live LevelDB folder
// is not safe if the old app is still open.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Pre-rename folder names: productName (installed builds) first, then the package name (development runs).
// These two strings are the only deliberate uses of the old name outside CHANGELOG.md (see tests/js/naming.test.mjs).
export const LEGACY_APP_DIRS = ['Strategy Showdown', 'strategy-showdown'];
export const MARKER = 'migrated-from.json';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links out of the folder
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Copy <appData>/<legacy>/data into <userData>/data once.
 * @param {{ appDataDir: string, userDataDir: string, legacyNames?: string[], now?: () => string, copyFile?: Function }} opts
 *   copyFile is injectable only so tests can simulate a failed copy.
 * @returns {{ status: 'migrated' | 'skipped-new-exists' | 'skipped-no-legacy' | 'failed', from?: string, files?: string[], error?: string }}
 */
export function migrateLegacyData({ appDataDir, userDataDir, legacyNames = LEGACY_APP_DIRS, now = () => new Date().toISOString(), copyFile = fs.copyFileSync }) {
  const target = path.join(userDataDir, 'data');
  if (fs.existsSync(target)) return { status: 'skipped-new-exists' };

  const source = legacyNames
    .map((name) => path.join(appDataDir, name, 'data'))
    .find((dir) => path.resolve(dir) !== path.resolve(target) && fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  if (!source) return { status: 'skipped-no-legacy' };

  const files = listFiles(source);
  const hashes = {};
  try {
    for (const rel of files) {
      const from = path.join(source, rel);
      const to = path.join(target, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      copyFile(from, to, fs.constants.COPYFILE_EXCL);
      const a = sha256(from);
      const b = sha256(to);
      if (a !== b) throw new Error(`hash mismatch after copying ${rel}`);
      hashes[rel] = a;
    }
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, MARKER), JSON.stringify({ from: path.dirname(source), at: now(), files: hashes }, null, 2));
    return { status: 'migrated', from: path.dirname(source), files };
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true }); // only this run created it (it did not exist above)
    return { status: 'failed', from: path.dirname(source), error: String(err && err.message ? err.message : err) };
  }
}
