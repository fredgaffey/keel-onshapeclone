import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, diffDesigns } from '../public/js/design-edit.js';

const base = JSON.stringify({ format: 'solidcraft/57', name: 'P', params: [{ name: 'w', expr: '10 mm', unit: 'mm', model: false }], features: [
  { id: 1, name: 'Sketch', type: 'sketch', suppressed: false },
  { id: 2, name: 'Plate', type: 'extrude', suppressed: false, distance: '6' },
], next_id: 3 });

test('edits apply in order, by id or name', () => {
  const { text, done } = applyEdits(base, [
    { op: 'rename', feature: 'Plate', name: 'Base plate' },
    { op: 'set', feature: 2, path: 'distance', value: 8 },
    { op: 'set_parameter', name: 'w', expr: '12 mm' },
    { op: 'set_parameter', name: 'angle', expr: '30 deg' },
    { op: 'suppress', feature: 1 },
    { op: 'add', feature: { type: 'fillet', radius: '1' }, after: 'Base plate' },
    { op: 'add', feature: { type: 'fillet', radius: '2' } },
  ]);
  const d = JSON.parse(text);
  assert.equal(done.length, 7);
  assert.equal(d.features[1].name, 'Base plate');
  assert.equal(d.features[1].distance, '8', 'a number over an expression stays an expression');
  assert.deepEqual(d.params.map((p) => [p.name, p.expr, p.unit]), [['w', '12 mm', 'mm'], ['angle', '30 deg', 'deg']]);
  assert.equal(d.features[0].suppressed, true);
  assert.deepEqual(d.features.map((f) => [f.id, f.name]), [[1, 'Sketch'], [2, 'Base plate'], [3, 'Fillet'], [4, 'Fillet 2']]);
  assert.equal(d.next_id, 5);
});

test('a bad edit names itself and changes nothing', () => {
  assert.throws(() => applyEdits(base, [{ op: 'rename', feature: 2, name: 'x' }, { op: 'delete', feature: 'Nope' }]), /Edit 2 \(delete\): No feature "Nope"/);
  assert.throws(() => applyEdits(base, [{ op: 'set', feature: 2, path: 'id', value: 9 }]), /id can't change/);
  assert.throws(() => applyEdits(base, [{ op: 'set', feature: 2, path: '__proto__.x', value: 1 }]), /Bad path/);
  assert.throws(() => applyEdits(base, [{ op: 'explode' }]), /Unknown op/);
});

test('diff reads like a change list', () => {
  const after = applyEdits(base, [{ op: 'rename', feature: 2, name: 'Base plate' }, { op: 'delete', feature: 1 }, { op: 'set_parameter', name: 'w', expr: '20 mm' }]).text;
  const d = diffDesigns(base, after);
  assert.deepEqual(d.features.removed, [{ id: 1, name: 'Sketch', type: 'sketch' }]);
  assert.deepEqual(d.features.changed[0].fields, [{ path: 'name', before: 'Plate', after: 'Base plate' }]);
  assert.match(d.summary, /removed "Sketch"/);
  assert.match(d.summary, /w 10 mm→20 mm/);
  assert.equal(diffDesigns(base, base).summary, 'no changes');
});

import { autoName, reviewDesign } from '../public/js/design-edit.js';

test('auto_name names defaults from what they do, and never a typed name', () => {
  const d = { features: [
    { id: 1, name: 'Box1', type: 'box', body_names: ['hub_jaw11'] },
    { id: 2, name: 'Move1', type: 'move', bodies: ['hub_jaw11'] },
    { id: 3, name: 'Combine1', type: 'combine', target: 'hub', tools: ['bore'], operation: 'cut' },
    { id: 4, name: 'My boss', type: 'cylinder', body_names: ['boss'] },
    { id: 5, name: 'Box2', type: 'box', body_names: ['hub_jaw11'] },
  ] };
  assert.equal(autoName(d), 4);
  assert.deepEqual(d.features.map((f) => f.name), ['Hub jaw 11 box', 'Place hub jaw 11', 'Cut bore from hub', 'My boss', 'Hub jaw 11 box 2']);
});

test('review flags what a reviewer would, and passes a tidy design', () => {
  const messy = JSON.stringify({ format: 'solidcraft/57', params: [], features: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Box${i + 1}`, type: 'box', length: '8', width: '4.8', height: '2.95', param_names: ['a', 'b', 'c'], body_names: [`b${i}`] })) });
  const r = reviewDesign(messy);
  assert.deepEqual(r.findings.map((f) => f.rule).sort(), ['magic-numbers', 'names', 'parameters', 'repeats']);
  assert.ok(r.score < 50);
  const tidy = JSON.stringify({ format: 'solidcraft/57', params: [{ name: 't', expr: '3 mm', unit: 'mm', model: false }], features: [{ id: 1, name: 'Base plate', type: 'box', length: 't', param_names: ['d1'] }] });
  assert.equal(reviewDesign(tidy).score, 100);
});
