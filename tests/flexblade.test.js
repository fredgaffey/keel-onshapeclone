import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expressionFor, parameterMap, pushParameters } from '../public/js/flexblade.js';

const design = {
  blade: { diameter_in: 5, n_blades: 2, root_cutout_frac: 0.18 },
  flexure: { skew_deg: 45, hinge_radius: 0.012, length: 0.008, thickness: 0.0012, width: 0.008, cross_angle_deg: 90, taper: 1, twist_deg: 0, hub_radius: 0.006 },
  op: { collective_deg: 2.5 },
};

test('SI lengths become millimetres, angles degrees, diameter inches', () => {
  assert.equal(expressionFor(0.0012, 'm'), '1.2 mm');
  assert.equal(expressionFor(45, 'deg'), '45 deg');
  assert.equal(expressionFor(5, 'in'), '5 in');
  assert.equal(expressionFor(2, ''), '2');
  const m = parameterMap(design);
  assert.equal(m.fb_flex_thickness.expression, '1.2 mm');
  assert.equal(m.fb_flex_thickness.unit, 'mm');
  assert.equal(m.fb_collective.expression, '2.5 deg');
  assert.equal(Object.keys(m).length, 13);
});

test('push adds new parameters and changes existing ones in one step', async () => {
  const params = { fb_skew: '30 deg' };
  const calls = [];
  const app = {
    async execute(command, p) {
      calls.push(command);
      if (command === 'parameters.add') {
        if (params[p.name]) throw new Error('exists');
        params[p.name] = p.expression;
      } else if (command === 'parameters.change') Object.assign(params, p.changes);
    },
  };
  const r = await pushParameters(app, design);
  assert.equal(r.added.length, 12);
  assert.deepEqual(r.changed, ['fb_skew']);
  assert.equal(params.fb_skew, '45 deg');
  assert.equal(calls.filter((c) => c === 'parameters.change').length, 1);
});
