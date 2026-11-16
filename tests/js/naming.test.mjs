// v0.4.0 rename: no stray use of the old product name in tracked files.
// The old name may appear only in CHANGELOG.md, in the data-migration module (which must know the old folder names),
// in this test, in the lockfile and vendored libraries, and in the unchanged appId (an identifier; changing it would
// make Windows install v0.4.0 beside the old version instead of upgrading it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const ALLOWED_FILES = new Set(['CHANGELOG.md', 'package-lock.json', 'desktop/electron/migrate.mjs', 'tests/js/naming.test.mjs', 'tests/js/migrate.test.mjs']);
const ALLOWED_PREFIXES = ['docs/vendor/'];
const ALLOWED_TOKENS = ['io.github.normansrule.strategyshowdown'];
const OLD = /strategy[- _]?showdown/gi;
const NEW_PREFIX = /trading[- _]?floor[- _]?$/i;

function strayHits(file, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    let clean = line;
    for (const tok of ALLOWED_TOKENS) clean = clean.split(tok).join('');
    for (const m of clean.matchAll(OLD)) {
      if (!NEW_PREFIX.test(clean.slice(0, m.index))) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
  return hits;
}

test('no stray old product name outside the allowed files', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    if (ALLOWED_FILES.has(f) || ALLOWED_PREFIXES.some((p) => f.startsWith(p))) continue;
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binary
    hits.push(...strayHits(f, buf.toString('utf8')));
  }
  assert.deepEqual(hits, []);
});

test('the checker itself: catches the old name, accepts the new one and the appId', () => {
  assert.equal(strayHits('x', 'Welcome to Strategy Showdown').length, 1);
  assert.equal(strayHits('x', 'github.com/Normansrule/strategy-showdown').length, 1);
  assert.equal(strayHits('x', 'Trading Floor Strategy Showdown and trading-floor-strategy-showdown').length, 0);
  assert.equal(strayHits('x', '"appId": "io.github.normansrule.strategyshowdown"').length, 0);
});
