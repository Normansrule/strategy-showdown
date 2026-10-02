// Shared helpers for the engine tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

export function loadJson(p) {
  return JSON.parse(readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8'));
}

/** Decode the string encodings make_expected.py uses for non-finite numbers. */
export function num(x) {
  if (x === 'Infinity') return Infinity;
  if (x === '-Infinity') return -Infinity;
  if (x === 'NaN') return NaN;
  return x;
}

/**
 * Assert |a − b| ≤ abs + rel·max(|a|, |b|). Infinite values must match exactly.
 * Default tolerances: relative 1e-9, absolute 1e-12.
 */
export function assertClose(actual, expected, label, { rel = 1e-9, abs = 1e-12 } = {}) {
  const e = num(expected);
  if (!Number.isFinite(e) || !Number.isFinite(actual)) {
    assert.ok(Object.is(actual, e) || (Number.isNaN(actual) && Number.isNaN(e)), `${label}: got ${actual}, expected ${e}`);
    return;
  }
  const tol = abs + rel * Math.max(Math.abs(actual), Math.abs(e));
  assert.ok(Math.abs(actual - e) <= tol, `${label}: got ${actual}, expected ${e} (|diff| ${Math.abs(actual - e)} > tol ${tol})`);
}

export function assertArrayClose(actual, expected, label, tol) {
  assert.equal(actual.length, expected.length, `${label}: length ${actual.length} vs ${expected.length}`);
  for (let i = 0; i < expected.length; i++) assertClose(actual[i], expected[i], `${label}[${i}]`, tol);
}

/** Deep copy of a dataset object. */
export const clone = x => JSON.parse(JSON.stringify(x));
