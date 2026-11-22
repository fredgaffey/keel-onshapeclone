// Default script: a parametric propeller as native SolidCraft features (sketches, loft, extrude,
// circular pattern). build(params) returns the command list; nothing here touches the engine.
//
// Frame: the prop turns about world Z and pushes air towards -Z (thrust +Z). Blade 1 lies along +X;
// each section is a sketch on the plane x = r (sketch x = world Y, the way the blade moves when
// spinning CCW seen from +Z; sketch y = world Z). Sections are stacked on their quarter-chord points.
import { closedSection } from './airfoil.js';

const IN = 25.4;
const deg = (rad) => rad * 180 / Math.PI;
const rad = (d) => d * Math.PI / 180;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

export const params = [
  { key: 'diameter', title: 'Diameter', type: 'number', unit: 'mm', default: 127, min: 40, max: 600 },
  { key: 'blades', title: 'Blades', type: 'integer', default: 2, min: 1, max: 8 },
  { key: 'hub_diameter', title: 'Hub diameter', type: 'number', unit: 'mm', default: 12, min: 4, max: 80 },
  { key: 'hub_height', title: 'Hub height', type: 'number', unit: 'mm', default: 8, min: 2, max: 60 },
  { key: 'bore', title: 'Bore', type: 'number', unit: 'mm', default: 5, min: 0, max: 60 },
  { key: 'pitch_mode', title: 'Twist from', type: 'enum', options: ['pitch', 'angles'], default: 'pitch' },
  { key: 'pitch', title: 'Pitch (geometric)', type: 'number', unit: 'in', default: 4.3, min: 0.5, max: 40 },
  { key: 'root_angle', title: 'Root pitch angle (angles mode)', type: 'number', unit: 'deg', default: 40, min: 0, max: 80 },
  { key: 'tip_angle', title: 'Tip pitch angle (angles mode)', type: 'number', unit: 'deg', default: 12, min: 0, max: 80 },
  { key: 'chord_root', title: 'Chord at root cutout', type: 'number', unit: 'mm', default: 14, min: 1, max: 200 },
  { key: 'chord_75', title: 'Chord at 0.75 R', type: 'number', unit: 'mm', default: 16, min: 1, max: 200 },
  { key: 'chord_tip', title: 'Chord at tip', type: 'number', unit: 'mm', default: 9, min: 1, max: 200 },
  { key: 'airfoil', title: 'Airfoil (clark-y or naca4412…)', type: 'string', default: 'clark-y' },
  { key: 'thickness_root', title: 'Thickness at root cutout', type: 'number', unit: '%', default: 16, min: 3, max: 40 },
  { key: 'thickness_tip', title: 'Thickness at tip', type: 'number', unit: '%', default: 9, min: 3, max: 40 },
  { key: 'te_thickness', title: 'Trailing edge thickness (rounded)', type: 'number', unit: 'mm', default: 0.2, min: 0.05, max: 2 },
  { key: 'sections', title: 'Blade sections', type: 'integer', default: 8, min: 3, max: 30 },
  { key: 'root_cutout', title: 'Root cutout r/R', type: 'number', default: 0.2, min: 0.05, max: 0.6 },
  { key: 'tip', title: 'Tip shape', type: 'enum', options: ['round', 'square'], default: 'round' },
  { key: 'spin', title: 'Spin (seen from the thrust side)', type: 'enum', options: ['ccw', 'cw'], default: 'ccw' },
  { key: 'root_flare', title: 'Root flare (blade-hub blend)', type: 'number', unit: 'mm', default: 0.6, min: 0, max: 5 },
];

/** Defaults filled in, strings from forms coerced by type. */
export function resolve(p = {}) {
  const out = {};
  for (const d of params) {
    let v = p[d.key] ?? d.default;
    if (d.type === 'number' || d.type === 'integer') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`${d.title}: not a number`);
      if (d.type === 'integer') v = Math.round(v);
      if (d.min != null && v < d.min) throw new Error(`${d.title}: at least ${d.min}`);
      if (d.max != null && v > d.max) throw new Error(`${d.title}: at most ${d.max}`);
    } else if (d.type === 'enum' && !d.options.includes(v)) throw new Error(`${d.title}: one of ${d.options.join(', ')}`);
    out[d.key] = v;
  }
  return out;
}

/** Pitch angle (deg) at radius r (mm). */
export function twistAt(p, r) {
  const R = p.diameter / 2, r0 = rootRadius(p);
  if (p.pitch_mode === 'angles') return p.root_angle + (p.tip_angle - p.root_angle) * (r - r0) / (R - r0);
  return deg(Math.atan(p.pitch * IN / (2 * Math.PI * r)));
}

/** Chord (mm) at radius r: a monotone cubic (PCHIP) through root/0.75R/tip, rounded off near the tip. */
export function chordAt(p, r) {
  const R = p.diameter / 2, xs = [rootRadius(p), 0.75 * R, R], ys = [p.chord_root, p.chord_75, p.chord_tip];
  const h = [xs[1] - xs[0], xs[2] - xs[1]], d = [(ys[1] - ys[0]) / h[0], (ys[2] - ys[1]) / h[1]];
  const end = (ha, hb, da, db) => {
    let m = ((2 * ha + hb) * da - ha * db) / (ha + hb);
    if (Math.sign(m) !== Math.sign(da)) m = 0;
    else if (Math.sign(da) !== Math.sign(db) && Math.abs(m) > Math.abs(3 * da)) m = 3 * da;
    return m;
  };
  const m = [end(h[0], h[1], d[0], d[1]), d[0] * d[1] <= 0 ? 0 : (h[0] + h[1]) * 3 / ((2 * h[1] + h[0]) / d[0] + (h[1] + 2 * h[0]) / d[1]), -end(h[1], h[0], -d[1], -d[0])];
  const i = r <= xs[1] ? 0 : 1, t = Math.min(Math.max((r - xs[i]) / h[i], 0), 1);
  let c = (2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * h[i] * m[i]
    + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * h[i] * m[i + 1];
  if (p.tip === 'round') {
    const rb = 0.8 * R;
    if (r > rb) c *= Math.sqrt(1 - (1 - 0.35 ** 2) * ((r - rb) / (R - rb)) ** 2);
  }
  return c;
}

export function rootRadius(p) {
  return Math.max(p.root_cutout * p.diameter / 2, 1.3 * p.hub_diameter / 2);
}

/** Blade stations: two inside the hub (the root neck, fitted to the hub height), then the aerofoil span. */
export function stations(p) {
  const R = p.diameter / 2, rh = p.hub_diameter / 2, r0 = rootRadius(p);
  if (r0 >= 0.9 * R) throw new Error('hub too large for this diameter');
  const out = [];
  for (let i = 0; i < p.sections; i++) {
    const s = Math.sin(Math.PI / 2 * i / (p.sections - 1)); // closer near the tip
    const r = r0 + (R - r0) * s;
    out.push({ r, chord: chordAt(p, r), beta: twistAt(p, r), t: (p.thickness_root + (p.thickness_tip - p.thickness_root) * s) / 100 });
  }
  // Quarter-chord stacking puts 3/4 of the chord behind (below) the axis: raise the aerofoil
  // stations' stacking line so the root section sits centred on the hub's mid-height.
  const dz = 0.25 * out[0].chord * Math.sin(rad(out[0].beta));
  for (const s of out) s.dz = dz;
  // Neck: thick, narrower and flatter, centred on the hub's mid-height (stacked at mid-chord). Where it
  // meets the hub it is `root_flare` bigger all round and narrows to the neck just outside the
  // hub: a lofted blend in place of a fillet (SolidCraft 0.46's fillet can't round this seam).
  const fl = p.root_flare, tn = 0.35, bn = Math.min(out[0].beta, 40);
  const sb = Math.sin(rad(bn)), cb = Math.cos(rad(bn));
  const room = Math.max(p.hub_height - 0.8 - 2 * fl * (sb + cb), 0.3 * p.hub_height);
  const cn = Math.min(out[0].chord, room / (sb + tn * cb), 1.6 * rh / cb - 2 * fl);
  const neck = { chord: cn, beta: bn, t: tn, te: 0.06, pivot: 0.5, neck: true };
  const fat = { ...neck, chord: cn + 2 * fl, t: (tn * cn + 2 * fl) / (cn + 2 * fl) };
  const rOut = Math.min(rh + 1.5 * fl + 0.6, (rh + r0) / 2);
  // Blend neck → root section through a few smoothstep-interpolated stations, so the loft (a spline
  // through its sections) has nothing to overshoot between the narrow neck and the wide root.
  const blend = [], K = 3, a = out[0];
  for (let k = 1; k <= K; k++) {
    const x = k / (K + 1), q = x * x * (3 - 2 * x), mix = (u, v) => u + (v - u) * q;
    blend.push({ r: mix(rOut, a.r), chord: mix(neck.chord, a.chord), beta: mix(neck.beta, a.beta), t: mix(neck.t, a.t),
      te: mix(neck.te, 0), pivot: mix(neck.pivot, 0.25), dz: mix(0, a.dz), blend: true });
    blend.at(-1).r = rOut + (a.r - rOut) * x; // evenly spaced radii, smooth shape
  }
  return [{ ...fat, r: 0.45 * rh }, { ...fat, r: rh }, { ...neck, r: rOut }, ...blend, ...out];
}

/**
 * Section loop in sketch coordinates (sketch x = world Y, y = world Z) for a station: a closed,
 * corner-free loop (rounded trailing edge) for a periodic spline, so the loft is smooth all round.
 */
export function sectionPoints(p, st, n = 14) {
  const te = Math.max(Math.min(p.te_thickness / st.chord, 0.05), st.te ?? 0);
  const loop = closedSection(p.airfoil, st.t, te, n);
  // Start the periodic spline (so the loft's seam) on the flat of the lower surface, mid-chord,
  // not at the tight trailing-edge round.
  const k = Math.round(1.5 * n);
  const pts = loop.slice(k).concat(loop.slice(0, k));
  const b = rad(st.beta), cb = Math.cos(b), sb = Math.sin(b), dir = p.spin === 'cw' ? -1 : 1;
  return pts.map(([x, y]) => {
    const u = ((st.pivot ?? 0.25) - x) * st.chord, v = y * st.chord; // leading edge towards +u, stacking point at 0
    return [r4(dir * (u * cb - v * sb)), r4(u * sb + v * cb + (st.dz ?? 0))];
  });
}

/**
 * The command list. opts.tag is appended to every feature, sketch and body name, so a second
 * propeller in the same document doesn't pick up the first one's sketches or body by name.
 */
export function build(input = {}, opts = {}) {
  const p = resolve(input);
  const T = (name) => name + (opts.tag || '');
  const rh = p.hub_diameter / 2, h = p.hub_height;
  if (p.bore >= p.hub_diameter - 1) throw new Error('bore must be at least 1 mm smaller than the hub');
  const cmds = [];
  const add = (command, params) => cmds.push({ command, params });

  // Hub and bore circles are sketched in a frame turned half a blade pitch, so their seams fall
  // between the blades rather than across a blade root.
  const a = Math.PI / p.blades, hubPlane = { origin: [0, 0, -h / 2], x_dir: [r4(Math.cos(a)), r4(Math.sin(a)), 0], y_dir: [r4(-Math.sin(a)), r4(Math.cos(a)), 0] };
  add('sketch.create', { plane: hubPlane, name: T('Prop hub') });
  add('sketch.circle.center', { center: [0, 0], radius: rh });
  add('sketch.finish', {});
  add('solid.extrude', { distance: h, operation: 'new', name: T('Hub'), body_name: T('Propeller') });

  const st = stations(p);
  st.forEach((s, i) => {
    const pts = sectionPoints(p, s);
    add('sketch.create', { plane: { origin: [r4(s.r), 0, 0], x_dir: [0, 1, 0], y_dir: [0, 0, 1] }, name: T(`Blade section ${i + 1}`) });
    add('sketch.spline.fit_point', { points: pts, periodic: true });
    add('sketch.finish', {});
  });
  add('solid.loft', { sections: st.map((_, i) => ({ sketch: T(`Blade section ${i + 1}`) })), operation: 'join', targets: [T('Propeller')], name: T('Blade') });

  const features = [T('Blade')];
  if (p.blades > 1) add('solid.pattern.circular', { features, axis: 'Z', count: p.blades, name: T('Blades') });

  if (p.bore > 0) {
    add('sketch.create', { plane: hubPlane, name: T('Prop bore') });
    add('sketch.circle.center', { center: [0, 0], radius: p.bore / 2 });
    add('sketch.finish', {});
    add('solid.extrude', { distance: h, through_all: true, direction: 'symmetric', operation: 'cut', targets: [T('Propeller')], name: T('Bore') });
  }
  return cmds;
}

export default {
  id: 'propeller',
  name: 'Propeller',
  description: 'Twisted, tapered blades lofted through Clark-Y or NACA sections, blended into a hub with a bore, patterned round it.',
  params,
  build,
};
