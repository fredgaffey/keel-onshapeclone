import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDelta, applyDelta } from '../scripts/cad-delta.mjs';

function rand(n, seed = 1) {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}

test('patches rebuild the new file exactly: inserts, deletes, moves and scattered byte changes', () => {
  const old = rand(400_000);
  const parts = [old.subarray(0, 100_000), rand(3000, 7), old.subarray(150_000, 300_000), old.subarray(10_000, 40_000), old.subarray(300_000)];
  const next = Buffer.concat(parts);
  for (let i = 5000; i < next.length; i += 997) next[i] ^= 0x5a; // relocated indices and offsets
  const patch = makeDelta(old, next);
  assert.deepEqual(Buffer.from(applyDelta(old, patch)), next);
  assert.ok(patch.subarray(0, 4).toString('latin1') === 'KDL1');
});

test('identical and unrelated files', () => {
  const a = rand(50_000, 3);
  assert.deepEqual(Buffer.from(applyDelta(a, makeDelta(a, a))), a);
  const b = rand(20_000, 9);
  assert.deepEqual(Buffer.from(applyDelta(a, makeDelta(a, b))), b);
  assert.deepEqual(Buffer.from(applyDelta(a, makeDelta(a, Buffer.alloc(0)))), Buffer.alloc(0));
});
