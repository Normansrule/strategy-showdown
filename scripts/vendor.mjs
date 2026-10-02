#!/usr/bin/env node
// Copy the pinned browser libraries from node_modules into docs/vendor/ and rewrite docs/vendor/SHA256SUMS.
// Run after changing the echarts or katex version in package.json:   npm ci && npm run vendor
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  ['node_modules/echarts/dist/echarts.min.js', 'docs/vendor/echarts/echarts.min.js'],
  ['node_modules/echarts/LICENSE', 'docs/vendor/echarts/LICENSE'],
  ['node_modules/katex/dist/katex.min.js', 'docs/vendor/katex/katex.min.js'],
  ['node_modules/katex/LICENSE', 'docs/vendor/katex/LICENSE'],
];
for (const [from, to] of FILES) {
  mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
  copyFileSync(path.join(ROOT, from), path.join(ROOT, to));
}
const sums = FILES.filter(([, to]) => to.endsWith('.js'))
  .map(([, to]) => `${createHash('sha256').update(readFileSync(path.join(ROOT, to))).digest('hex')}  ${to}`);
writeFileSync(path.join(ROOT, 'docs/vendor/SHA256SUMS'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
