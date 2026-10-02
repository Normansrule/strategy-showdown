// sha256Hex (docs/engine/hash.js) against Node's crypto implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex, canonicalJson } from '../../docs/engine/hash.js';

const nodeSha = x => createHash('sha256').update(x).digest('hex');

test('sha256Hex: known vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex matches node:crypto across padding boundaries and multi-block inputs', () => {
  const inputs = ['', 'a', 'abc', 'The quick brown fox jumps over the lazy dog'];
  for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 100000]) inputs.push('x'.repeat(n));
  inputs.push('héllo wörld — ∑ 漢字 🙂'.repeat(7)); // multi-byte UTF-8, > 64 bytes
  for (const s of inputs) assert.equal(sha256Hex(s), nodeSha(s), `length ${s.length}`);
});

test('sha256Hex accepts bytes (Uint8Array)', () => {
  const bytes = new Uint8Array(300).map((_, i) => (i * 37) & 0xff);
  assert.equal(sha256Hex(bytes), nodeSha(bytes));
});

test('canonicalJson sorts keys at every depth, so key order does not change the hash', () => {
  const a = { b: 1, a: { d: [1, { z: 0, y: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [1, { y: 2, z: 0 }] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[1,{"y":2,"z":0}]},"b":1}');
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});
