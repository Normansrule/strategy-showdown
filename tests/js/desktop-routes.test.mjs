// Desktop app URL mapping and request policy (pure functions; the Electron launch test is tests/desktop/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mapAppUrl, isAllowedRequest, isExternalLinkAllowed, isFrenchDownloadUrl } from '../../desktop/electron/routes.mjs';
import { FRENCH_FILES } from '../../docs/engine/data/loaders.js';

const roots = { docsRoot: path.resolve('/app/docs'), dataRoot: path.resolve('/user/data') };

test('app:// maps into docs/, and /data/local/* into the user data folder', () => {
  assert.equal(mapAppUrl('app://showdown/', roots), path.resolve('/app/docs/index.html'));
  assert.equal(mapAppUrl('app://showdown/assets/js/showdown.js', roots), path.resolve('/app/docs/assets/js/showdown.js'));
  assert.equal(mapAppUrl('app://showdown/data/local/french.json', roots), path.resolve('/user/data/french.json'));
  assert.equal(mapAppUrl('app://showdown/data/citations.json', roots), path.resolve('/app/docs/data/citations.json'));
});

test('traversal, dotfiles, encoded slashes, other hosts and schemes are refused', () => {
  for (const u of [
    'app://showdown/data/local/..%2f..%2fsecret', 'app://showdown/.git/config',
    'app://showdown/data/local/.hidden', 'app://other/index.html', 'https://showdown/index.html', 'file:///etc/passwd',
    'app://showdown/a%5cb', 'app://showdown/data/local', 'not a url',
  ]) assert.equal(mapAppUrl(u, roots), null, u);
  // The URL parser normalizes /../ before we see it; the result must still be inside docs/.
  for (const u of ['app://showdown/../../etc/passwd', 'app://showdown/data/local/%2e%2e/%2e%2e/x']) {
    const p = mapAppUrl(u, roots);
    assert.ok(p === null || p.startsWith(roots.docsRoot + path.sep) || p.startsWith(roots.dataRoot + path.sep), `${u} → ${p}`);
  }
});

test('only the app origin (and page-made data:/blob:) may be requested', () => {
  assert.ok(isAllowedRequest('app://showdown/index.html'));
  assert.ok(isAllowedRequest('data:image/png;base64,AAAA'));
  for (const u of ['https://example.com/', 'http://127.0.0.1:8080/', 'file:///etc/passwd', 'ws://x', 'app://evil/x']) assert.ok(!isAllowedRequest(u), u);
});

test('external links: https only, no credentials in the URL', () => {
  assert.ok(isExternalLinkAllowed('https://doi.org/10.1111/j.1540-6261.1993.tb04702.x'));
  for (const u of ['http://example.com', 'file:///C:/x', 'javascript:alert(1)', 'https://user:pw@example.com/', 'smb://host/share']) assert.ok(!isExternalLinkAllowed(u), u);
});

test('downloads are limited to the exact French library URLs', () => {
  for (const f of FRENCH_FILES) assert.ok(isFrenchDownloadUrl(f.url, FRENCH_FILES));
  assert.ok(!isFrenchDownloadUrl('https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/../evil.zip', FRENCH_FILES));
  assert.ok(!isFrenchDownloadUrl('https://example.com/F-F_Research_Data_Factors_CSV.zip', FRENCH_FILES));
});
