import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDesigns } from '../public/js/merge.js';

const design = (features, extra = {}) => JSON.stringify({ format: 'solidcraft/57', name: 'D', units: 'mm', params: [], features, next_id: Math.max(0, ...features.map((f) => f.id)) + 1, ...extra }, null, 2);
const box = (id, name, length, params) => ({ id, name, suppressed: false, body_names: [name], param_names: params, type: 'box', corner: [0, 0, 0], length: String(length), width: '20', height: '10', operation: 'new_body' });

const base = design([box(1, 'Box1', 30, ['d1', 'd2', 'd3'])]);

test('one side changed: take it', () => {
  const mine = design([box(1, 'Box1', 50, ['d1', 'd2', 'd3'])]);
  assert.equal(mergeDesigns(base, mine, base).text, mine);
  assert.equal(mergeDesigns(base, base, mine).text, mine);
});

test('concurrent new features get distinct ids and dimension names', () => {
  const mine = design([box(1, 'Box1', 30, ['d1', 'd2', 'd3']), box(2, 'Mine', 5, ['d4', 'd5', 'd6'])]);
  const theirs = design([box(1, 'Box1', 30, ['d1', 'd2', 'd3']), box(2, 'Theirs', 7, ['d4', 'd5', 'd6'])]);
  const r = JSON.parse(mergeDesigns(base, mine, theirs).text);
  assert.deepEqual(r.features.map((f) => [f.id, f.name]), [[1, 'Box1'], [2, 'Theirs'], [3, 'Mine']]);
  assert.deepEqual(r.features[2].param_names, ['d7', 'd8', 'd9']);
  assert.equal(r.next_id, 4);
});

test('references inside my new features follow the renumbering', () => {
  const sketch = (id) => ({ id, name: 'Sketch', type: 'sketch', param_names: [] });
  const extrude = (id, sk) => ({ id, name: 'Extrude', type: 'extrude', sketch: sk, distance: 'd4 * 2', param_names: ['d4'] });
  const mine = design([box(1, 'Box1', 30, ['d1', 'd2', 'd3']), sketch(2), extrude(3, 2)]);
  const theirs = design([box(1, 'Box1', 30, ['d1', 'd2', 'd3']), box(2, 'T', 1, ['d4', 'd5', 'd6'])]);
  const r = JSON.parse(mergeDesigns(base, mine, theirs).text);
  const ex = r.features.find((f) => f.type === 'extrude');
  const sk = r.features.find((f) => f.type === 'sketch');
  assert.equal(ex.sketch, sk.id);
  assert.notEqual(sk.id, 2);
  assert.equal(ex.distance, `${ex.param_names[0]} * 2`);
  assert.notEqual(ex.param_names[0], 'd4');
});

test('field-level merge of one feature edited on both sides', () => {
  const m = box(1, 'Box1', 30, ['d1', 'd2', 'd3']); m.width = '99';
  const t = box(1, 'Box1', 30, ['d1', 'd2', 'd3']); t.height = '77';
  const r = mergeDesigns(base, design([m]), design([t]));
  const f = JSON.parse(r.text).features[0];
  assert.equal(f.width, '99'); assert.equal(f.height, '77');
  assert.deepEqual(r.conflicts, []);
});

test('same field on both sides: later edit wins, reported', () => {
  const r = mergeDesigns(base, design([box(1, 'Box1', 40, ['d1', 'd2', 'd3'])]), design([box(1, 'Box1', 45, ['d1', 'd2', 'd3'])]));
  assert.equal(JSON.parse(r.text).features[0].length, '40');
  assert.equal(r.conflicts.length, 1);
});

test('delete beats edit', () => {
  const r = mergeDesigns(base, design([]), design([box(1, 'Box1', 45, ['d1', 'd2', 'd3'])]));
  assert.equal(JSON.parse(r.text).features.length, 0);
  assert.equal(r.conflicts.length, 1);
});

test('big integers survive', () => {
  const big = '18446744073709551557';
  const b = base.replace('"units": "mm"', `"units": "mm",\n  "seed": ${big}`);
  const m = b.replace('"30"', '"31"');
  const t = b.replace('"name": "D"', '"name": "E"');
  const r = mergeDesigns(b, m, t).text;
  assert.match(r, new RegExp(`"seed": ${big}`));
  assert.match(r, /"name": "E"/);
  assert.match(r, /"length": "31"/);
});

test('prefer theirs keeps their value and details describe the clash', () => {
  const base = JSON.stringify({ format: 'solidcraft/57', features: [{ id: 1, name: 'Box', depth: 10 }], next_id: 2 });
  const mine = JSON.stringify({ format: 'solidcraft/57', features: [{ id: 1, name: 'Box', depth: 20 }], next_id: 2 });
  const theirs = JSON.stringify({ format: 'solidcraft/57', features: [{ id: 1, name: 'Box', depth: 30 }], next_id: 2 });
  const r = mergeDesigns(base, mine, theirs, { prefer: 'theirs' });
  assert.equal(JSON.parse(r.text).features[0].depth, 30);
  assert.deepEqual(r.details, [{ path: 'feature 1.depth', kind: 'both-changed', base: 10, mine: 20, theirs: 30, kept: 'theirs' }]);
  assert.equal(JSON.parse(mergeDesigns(base, mine, theirs).text).features[0].depth, 20);
});
