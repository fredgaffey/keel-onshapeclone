import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS, byId, defaults } from '../public/js/scripts/index.js';
import { resolve, stations, sectionPoints, chordAt, twistAt, build } from '../public/js/scripts/propeller.js';
import { runCommands } from '../public/js/scripts-panel.js';

test('every default script builds a non-empty command list from its defaults', () => {
  assert.ok(SCRIPTS.length >= 1);
  for (const s of SCRIPTS) {
    assert.match(s.id, /^[a-z_]+$/);
    assert.ok(s.name && s.description && s.params.length, s.id);
    for (const p of s.params) assert.ok(p.key && p.title && p.type && 'default' in p, `${s.id}.${p.key}`);
    const cmds = s.build(defaults(s));
    assert.ok(cmds.length > 5, s.id);
    for (const c of cmds) {
      assert.equal(typeof c.command, 'string');
      assert.equal(typeof c.params, 'object');
      assert.ok(!c.command.startsWith('file.'), 'no file commands: they run in the browser');
    }
    assert.ok(cmds.some((c) => c.command === 'solid.loft'), `${s.id} lofts`);
    // every sketch is finished before the next one starts
    let open = false;
    for (const c of cmds) {
      if (c.command === 'sketch.create') { assert.ok(!open, `${s.id}: nested sketch`); open = true; }
      if (c.command === 'sketch.finish') open = false;
    }
    assert.ok(!open);
    assert.deepEqual(s.build({}), cmds, 'build({}) uses the defaults');
  }
});

test('propeller: geometric pitch twist falls and the chord tapers to the tip', () => {
  const p = resolve({ tip: 'square' });
  const st = stations(p).filter((s) => !s.neck && !s.blend);
  for (let i = 1; i < st.length; i++) {
    assert.ok(st[i].r > st[i - 1].r);
    assert.ok(st[i].beta < st[i - 1].beta, 'twist decreases outwards');
  }
  // constant pitch: 2πr·tanβ = P everywhere
  for (const s of st) assert.ok(Math.abs(2 * Math.PI * s.r * Math.tan(s.beta * Math.PI / 180) - 4.3 * 25.4) < 1e-9);
  const R = p.diameter / 2;
  assert.ok(Math.abs(chordAt(p, 0.75 * R) - 16) < 1e-9);
  assert.ok(Math.abs(chordAt(p, R) - 9) < 1e-9);
  for (let r = 0.75 * R; r < R; r += 1) assert.ok(chordAt(p, r + 1) <= chordAt(p, r) + 1e-12, 'tapers past 0.75R');
  for (let r = st[0].r; r <= R; r += 0.5) assert.ok(chordAt(p, r) <= 16 + 1e-9, 'never wider than the widest given chord');
  const round = resolve({});
  assert.ok(chordAt(round, R) < 0.5 * chordAt(p, R), 'round tip narrows');
  const ang = resolve({ pitch_mode: 'angles', root_angle: 30, tip_angle: 10 });
  assert.ok(Math.abs(twistAt(ang, R) - 10) < 1e-9);
});

test('propeller: the neck (flare included) stays inside the hub height and reaches into the hub', () => {
  const p = resolve({});
  const neck = stations(p).filter((s) => s.neck);
  assert.ok(neck[0].r < p.hub_diameter / 2 && neck.at(-1).r > p.hub_diameter / 2);
  for (const s of neck) for (const [, z] of sectionPoints(p, s)) assert.ok(Math.abs(z) < p.hub_height / 2 - 0.5);
});

test('propeller: spin direction mirrors the blade across XZ', () => {
  const ccw = build({ spin: 'ccw' }), cw = build({ spin: 'cw' });
  assert.equal(ccw.length, cw.length);
  const splines = (cmds) => cmds.filter((c) => c.command === 'sketch.spline.fit_point').map((c) => c.params.points);
  const a = splines(ccw), b = splines(cw);
  assert.ok(a.length >= 8);
  a.forEach((pts, i) => pts.forEach(([x, y], j) => { assert.equal(b[i][j][0], -x || 0); assert.equal(b[i][j][1], y); }));
  // and the leading edge (the max-x point for CCW) moves +Y, rising (positive pitch)
  const st = stations(resolve({})).at(-3);
  const pts = sectionPoints(resolve({}), st);
  const le = pts.reduce((m, q) => (q[0] > m[0] ? q : m));
  const te = pts.reduce((m, q) => (q[0] < m[0] ? q : m));
  assert.ok(le[1] > te[1]);
});

test('propeller: bad parameters are refused with the field name', () => {
  assert.throws(() => build({ blades: 0 }), /Blades/);
  assert.throws(() => build({ airfoil: 'naca12' }), /airfoil/);
  assert.throws(() => build({ bore: 12 }), /bore/);
  assert.ok(byId('propeller').build({ airfoil: 'NACA 4412', blades: '3' }).some((c) => c.params.count === 3));
});

test('a name tag keeps two runs apart', () => {
  const names = (cmds) => cmds.flatMap((c) => [c.params.name, c.params.body_name, ...(c.params.targets || []), ...(c.params.sections || []).map((x) => x.sketch)]).filter(Boolean);
  const plain = names(build({})), tagged = names(build({}, { tag: ' x1' }));
  assert.equal(plain.length, tagged.length);
  assert.ok(tagged.every((n) => n.endsWith(' x1')));
  assert.ok(plain.includes('Propeller') && plain.includes('Blade section 1'));
});

test('runCommands runs in order and names the failing step', async () => {
  const seen = [];
  const app = { async execute(c) { seen.push(c); if (c === 'solid.loft') throw new Error('nope'); } };
  await assert.rejects(runCommands(app, build({})), /solid\.loft.*nope/);
  assert.equal(seen.at(-1), 'sketch.cancel');
});
