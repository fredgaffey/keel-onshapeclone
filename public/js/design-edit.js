// Small, typed edits to a SolidCraft design, and a readable diff between two designs. Pure data:
// the Worker applies edits for agents without modelling, and the result goes through the same
// merge as any other change. The modelling kernel (in a browser tab) checks the result.
//
// Edits, applied in order (a feature is named by its id or its exact name):
//   {op:'set_parameter', name, expr, unit?, comment?}   create or change a parameter ("25 mm", "width/2")
//   {op:'delete_parameter', name}
//   {op:'rename', feature, name}
//   {op:'suppress', feature, suppressed?: true}
//   {op:'delete', feature}
//   {op:'set', feature, path, value}                    path: "depth" or "extent.distance" or ["a", 0, "b"]
//   {op:'add', feature: {type, name?, ...}, after?}     id comes from next_id; after: a feature (default: the end)
//   {op:'move', feature, after}                         after: a feature, or null for the start
//   {op:'rename_design', name}
//   {op:'auto_name'}                                    name every feature still called "Box12", "Combine5"…
//                                                       after what it does; names anyone typed are kept

export const EDIT_OPS = ['set_parameter', 'delete_parameter', 'rename', 'suppress', 'delete', 'set', 'add', 'move', 'rename_design', 'auto_name'];

const UNIT_RE = /^(mm|deg|)$/;

export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('Give a list of edits.');
  if (edits.filter((e) => e?.op !== 'auto_name').length > 500) throw new Error('At most 500 edits at once.');
  const d = JSON.parse(text);
  d.features ||= [];
  d.params ||= [];
  const done = [];
  edits.forEach((e, i) => {
    try {
      done.push(applyOne(d, e));
    } catch (err) {
      throw new Error(`Edit ${i + 1} (${e?.op ?? 'no op'}): ${err.message}`);
    }
  });
  return { text: JSON.stringify(d, null, 2), done };
}

function findFeature(d, ref) {
  if (ref === undefined || ref === null || ref === '') throw new Error('Say which feature (its id or name).');
  const byId = d.features.find((f) => f.id === ref || String(f.id) === String(ref));
  if (byId) return byId;
  const byName = d.features.filter((f) => f.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`${byName.length} features are named "${ref}"; use the id (${byName.map((f) => f.id).join(', ')}).`);
  throw new Error(`No feature "${ref}". Features: ${d.features.slice(0, 40).map((f) => `${f.id} ${f.name}`).join('; ')}${d.features.length > 40 ? '; …' : ''}`);
}

const usedNames = (d) => new Set(d.features.map((f) => f.name));

// "Rib", "Rib 2", "Rib 3"... the first free one.
export function freeName(d, base) {
  const used = usedNames(d);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

// A readable default name from a feature type: "BoxFeature" -> "Box", "sketch" -> "Sketch".
export function nameFromType(type) {
  const s = String(type || 'Feature').replace(/Feature$/, '').replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Feature';
}

function setPath(obj, path, value, create = false) {
  const keys = Array.isArray(path) ? path : String(path).split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k));
  if (!keys.length || keys.some((k) => k === '' || k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error('Bad path.');
  if (keys[0] === 'id') throw new Error('A feature\'s id can\'t change.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') throw new Error(`"${keys.join('.')}" doesn't exist in this feature (stopped at "${k}").`);
    o = o[k];
  }
  const last = keys[keys.length - 1];
  if (!(last in o) && !create && value !== undefined) {
    const have = Object.keys(o).filter((k) => k !== 'id').slice(0, 30).join(', ');
    throw new Error(`"${keys.join('.')}" isn't a field of this feature (it has: ${have}). Check the spelling, or pass create: true to add a new field.`);
  }
  const before = o[last];
  // Dimensions are expression strings ("12", "width / 2"); a bare number written over one is meant
  // as that expression, and the modeller refuses a number there.
  if (typeof before === 'string' && typeof value === 'number') value = String(value);
  if (value === undefined) delete o[last]; else o[last] = value;
  return before;
}

function applyOne(d, e) {
  switch (e?.op) {
    case 'set_parameter': {
      const name = String(e.name || '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('A parameter name is letters, digits and _, starting with a letter.');
      if (e.expr === undefined || e.expr === null || String(e.expr).trim() === '') throw new Error('Give expr, e.g. "25 mm" or "width / 2".');
      checkExpr(String(e.expr), d, name);
      const p = d.params.find((x) => x.name === name);
      const unit = e.unit ?? p?.unit ?? guessUnit(String(e.expr));
      if (!UNIT_RE.test(unit)) throw new Error('unit is "mm", "deg" or "" (none).');
      if (p) {
        const before = p.expr;
        p.expr = String(e.expr); p.unit = unit;
        if (e.comment !== undefined) p.comment = String(e.comment);
        return `parameter ${name}: ${before} → ${p.expr}`;
      }
      d.params.push({ name, expr: String(e.expr), unit, ...(e.comment ? { comment: String(e.comment) } : {}), model: false });
      return `parameter ${name} = ${e.expr} (new)`;
    }
    case 'delete_parameter': {
      const i = d.params.findIndex((x) => x.name === e.name);
      if (i < 0) throw new Error(`No parameter "${e.name}".`);
      const users = usersOf(d, e.name);
      if (users.length) throw new Error(`"${e.name}" is used by ${users.slice(0, 8).join(', ')}${users.length > 8 ? ', …' : ''}. Change those first (or set the parameter instead of deleting it).`);
      d.params.splice(i, 1);
      return `parameter ${e.name} deleted`;
    }
    case 'rename': {
      const f = findFeature(d, e.feature);
      const name = String(e.name || '').trim().slice(0, 120);
      if (!name) throw new Error('Give the new name.');
      const before = f.name;
      f.name = name;
      return `feature ${f.id}: "${before}" → "${name}"`;
    }
    case 'suppress': {
      const f = findFeature(d, e.feature);
      f.suppressed = e.suppressed !== false;
      return `feature ${f.id} "${f.name}" ${f.suppressed ? 'suppressed' : 'unsuppressed'}`;
    }
    case 'delete': {
      const f = findFeature(d, e.feature);
      d.features = d.features.filter((x) => x !== f);
      return `feature ${f.id} "${f.name}" deleted`;
    }
    case 'set': {
      const f = findFeature(d, e.feature);
      const before = setPath(f, e.path, e.value, !!e.create);
      return `feature ${f.id} "${f.name}" ${Array.isArray(e.path) ? e.path.join('.') : e.path}: ${JSON.stringify(before)} → ${JSON.stringify(e.value)}`;
    }
    case 'add': {
      const src = e.feature;
      if (!src || typeof src !== 'object' || Array.isArray(src) || !src.type) throw new Error('Give the feature as an object with a type (copy the shape of an existing feature of that type).');
      const id = Math.max(Number(d.next_id) || 1, ...d.features.map((f) => (Number(f.id) || 0) + 1));
      const f = { ...src, id, name: src.name ? String(src.name) : freeName(d, nameFromType(src.type)), suppressed: !!src.suppressed };
      if (f.name && usedNames(d).has(f.name) && !src.name) f.name = freeName(d, f.name);
      let at = d.features.length;
      if (e.after !== undefined && e.after !== null) at = d.features.indexOf(findFeature(d, e.after)) + 1;
      else if (e.after === null) at = 0;
      d.features.splice(at, 0, f);
      d.next_id = id + 1;
      return `feature ${id} "${f.name}" added`;
    }
    case 'move': {
      const f = findFeature(d, e.feature);
      d.features = d.features.filter((x) => x !== f);
      const at = e.after === null || e.after === undefined ? 0 : d.features.indexOf(findFeature(d, e.after)) + 1;
      d.features.splice(at, 0, f);
      return `feature ${f.id} "${f.name}" moved`;
    }
    case 'auto_name': {
      const n = autoName(d);
      return n ? `${n} feature${n > 1 ? 's' : ''} named` : 'every feature already has a name';
    }
    case 'rename_design': {
      const name = String(e.name || '').trim().slice(0, 120);
      if (!name) throw new Error('Give the new name.');
      d.name = name;
      return `design renamed "${name}"`;
    }
    default:
      throw new Error(`Unknown op. Ops: ${EDIT_OPS.join(', ')}.`);
  }
}

function guessUnit(expr) {
  if (/\bdeg\b|°/.test(expr)) return 'deg';
  if (/\b(mm|cm|m|in|ft)\b/.test(expr)) return 'mm';
  return '';
}

// What changed from a to b, readably: features added, removed, renamed, moved, and each changed
// field (with before and after); parameters; and other top-level fields.
export function diffDesigns(aText, bText, { maxValue = 200 } = {}) {
  const a = JSON.parse(aText), b = JSON.parse(bText);
  const short = (v) => { const s = JSON.stringify(v); return s === undefined ? undefined : s.length > maxValue ? `${s.slice(0, maxValue)}…` : JSON.parse(s.length > maxValue ? 'null' : s); };
  const out = { features: { added: [], removed: [], changed: [] }, params: { added: [], removed: [], changed: [] }, design: [] };
  const A = new Map((a.features || []).map((f) => [f.id, f])), B = new Map((b.features || []).map((f) => [f.id, f]));
  for (const [id, f] of B) if (!A.has(id)) out.features.added.push({ id, name: f.name, type: f.type });
  for (const [id, f] of A) if (!B.has(id)) out.features.removed.push({ id, name: f.name, type: f.type });
  for (const [id, fb] of B) {
    const fa = A.get(id);
    if (!fa) continue;
    const fields = [];
    fieldDiff(fa, fb, '', fields);
    if (fields.length) out.features.changed.push({ id, name: fb.name, fields: fields.slice(0, 50).map((x) => ({ path: x.path, before: short(x.before), after: short(x.after) })), ...(fields.length > 50 ? { more: fields.length - 50 } : {}) });
  }
  const orderA = (a.features || []).map((f) => f.id).filter((id) => B.has(id)), orderB = (b.features || []).map((f) => f.id).filter((id) => A.has(id));
  if (orderA.join() !== orderB.join()) out.features.reordered = true;
  const P = (list) => new Map((list || []).map((p) => [p.name, p]));
  const PA = P(a.params), PB = P(b.params);
  for (const [n, p] of PB) {
    if (!PA.has(n)) out.params.added.push({ name: n, expr: p.expr });
    else if (JSON.stringify(PA.get(n)) !== JSON.stringify(p)) out.params.changed.push({ name: n, before: PA.get(n).expr, after: p.expr });
  }
  for (const n of PA.keys()) if (!PB.has(n)) out.params.removed.push({ name: n });
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'features' || k === 'params' || k === 'next_id' || k === 'format' || k === 'format_pending') continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.design.push({ field: k, before: short(a[k]), after: short(b[k]) });
  }
  out.summary = summarize(out);
  return out;
}

function fieldDiff(x, y, path, out) {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  const obj = (v) => v !== null && typeof v === 'object';
  if (obj(x) && obj(y) && Array.isArray(x) === Array.isArray(y) && out.length < 200) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) fieldDiff(x[k], y[k], path ? `${path}.${k}` : k, out);
    return;
  }
  out.push({ path, before: x, after: y });
}

function summarize(o) {
  const parts = [];
  const f = o.features, p = o.params;
  if (f.added.length) parts.push(`added ${f.added.map((x) => `"${x.name}"`).join(', ')}`);
  if (f.removed.length) parts.push(`removed ${f.removed.map((x) => `"${x.name}"`).join(', ')}`);
  if (f.changed.length) parts.push(`changed ${f.changed.map((x) => `"${x.name}" (${x.fields.map((y) => y.path).slice(0, 4).join(', ')}${x.fields.length > 4 ? ', …' : ''})`).join(', ')}`);
  if (f.reordered) parts.push('reordered features');
  if (p.added.length || p.changed.length || p.removed.length) parts.push(`parameters: ${[...p.added.map((x) => `+${x.name}`), ...p.changed.map((x) => `${x.name} ${x.before}→${x.after}`), ...p.removed.map((x) => `-${x.name}`)].join(', ')}`);
  for (const d of o.design) parts.push(`${d.field} changed`);
  return parts.length ? parts.join('; ') : 'no changes';
}


// ---- automatic names ----
// SolidCraft's own default names: the command's word and a counter.
export const DEFAULT_NAME = /^(Box|Cylinder|Sphere|Cone|Torus|Wedge|Move|Copy|Combine|Extrude|Revolve|Loft|Sweep|Fillet|Chamfer|Shell|Hole|Draft|Sketch|Pattern|Mirror|Split|Thicken|Offset|Plane|Axis|Point|Scale|Feature)\s?\d+$/;

const human = (s) => String(s).replace(/[_-]+/g, ' ').replace(/([a-z])(\d)/gi, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
const list = (names) => (names.length > 3 ? `${names.length} bodies` : names.map((n) => human(n).toLowerCase()).join(', '));
const typeWord = (f) => String(f.type || 'feature').replace(/Feature$/, '').replace(/[_.]/g, ' ').toLowerCase();

// A name from what a feature does, or null when there's nothing better than the default.
export function describeFeature(f) {
  const t = String(f.type || '').toLowerCase();
  const bodies = f.body_names || [];
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  if (t === 'move' || t === 'copy') return arr(f.bodies).length ? `Place ${list(arr(f.bodies))}` : null;
  if (t === 'combine') {
    const tools = arr(f.tools), target = f.target ? human(f.target).toLowerCase() : 'body';
    if (!tools.length) return null;
    if (f.operation === 'cut') return `Cut ${list(tools)} from ${target}`;
    if (f.operation === 'intersect') return `Intersect ${target} with ${list(tools)}`;
    return `Join ${list(tools)} to ${target}`;
  }
  if (t === 'fillet' || t === 'chamfer') return `${t === 'fillet' ? 'Round' : 'Chamfer'} ${f.body ? `${human(f.body).toLowerCase()} ` : ''}edges${f.radius ? ` (${f.radius})` : f.distance ? ` (${f.distance})` : ''}`;
  if (t.includes('pattern') || t === 'mirror') {
    const what = arr(f.features).length ? `${arr(f.features).length} feature${arr(f.features).length > 1 ? 's' : ''}` : arr(f.bodies).length ? list(arr(f.bodies)) : '';
    return `${t === 'mirror' ? 'Mirror' : 'Pattern'}${what ? ` ${what}` : ''}`;
  }
  if (bodies.length) return `${human(bodies[0])}${bodies.length > 1 ? ` (+${bodies.length - 1})` : ''} ${typeWord(f)}`;
  return null;
}

export function autoName(d) {
  let n = 0;
  for (const f of d.features || []) {
    if (!DEFAULT_NAME.test(String(f.name || '')) && f.name) continue;
    const name = describeFeature(f);
    if (!name) continue;
    f.name = freeName({ features: d.features.filter((x) => x !== f) }, name.slice(0, 100));
    n++;
  }
  return n;
}

// ---- design review: what a CAD reviewer would flag ----
export function reviewDesign(text) {
  const d = JSON.parse(text);
  const feats = d.features || [];
  const findings = [];
  const add = (severity, rule, message, fix, examples) => findings.push({ severity, rule, message, fix, ...(examples?.length ? { examples: examples.slice(0, 6) } : {}) });

  const unnamed = feats.filter((f) => !f.name || DEFAULT_NAME.test(f.name));
  if (unnamed.length) add('high', 'names', `${unnamed.length} of ${feats.length} features still have default names, so the timeline doesn't say what anything is.`, 'edit_document [{op:"auto_name"}] names them from what they do; better, pass name: to every command ("Mounting holes", not "Extrude3").', unnamed.map((f) => `${f.id} ${f.name}`));

  const userParams = (d.params || []).filter((p) => !p.model);
  const dims = feats.flatMap((f) => (f.param_names || []).length);
  const nDims = dims.reduce((a, b) => a + b, 0);
  if (!userParams.length && nDims >= 6) add('high', 'parameters', `No design parameters: all ${nDims} dimensions are typed-in numbers, so changing the design means editing them one by one.`, 'set_parameter the driving sizes (thickness, bore, length...) and use them in expressions ("plate_t", "bore_d / 2") when you create features.');

  // Literal numbers repeated across features: candidates for a parameter.
  const counts = new Map();
  const walk = (v, f) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?( ?mm| ?deg)?$/.test(v.trim()) && Number(v) !== 0) counts.set(v.trim(), (counts.get(v.trim()) || new Set()).add(f.id));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) if (k !== 'id' && k !== 'sketch') walk(v[k], f);
  };
  for (const f of feats) for (const k of ['length', 'width', 'height', 'radius', 'distance', 'depth', 'thickness', 'diameter', 'extent']) if (f[k] !== undefined) walk(f[k], f);
  const repeated = [...counts].filter(([, ids]) => ids.size >= 3).sort((a, b) => b[1].size - a[1].size);
  if (repeated.length) add('medium', 'magic-numbers', `${repeated.length} value${repeated.length > 1 ? 's are' : ' is'} typed into 3 or more features.`, 'Make each a parameter so they change together.', repeated.map(([v, ids]) => `${v} in ${ids.size} features`));

  // Computed placements: moves with long decimals or oblique axes.
  const oddMoves = feats.filter((f) => String(f.type).toLowerCase() === 'move' && (JSON.stringify(f.translate || '').match(/\d\.\d{6,}/) || JSON.stringify(f.rotate_axis || '').match(/\d\.\d{6,}/)));
  if (oddMoves.length) add('medium', 'placement', `${oddMoves.length} move features place bodies with computed numbers (long decimals or tilted axes), which nobody can read or adjust.`, 'Sketch on a plane or construction plane placed where the part goes (sketch.create plane {origin, x_dir, y_dir} with parameter expressions), or use mirror and patterns.', oddMoves.map((f) => `${f.id} ${f.name}`));

  // Bodies made separately then combined, where an operation on the feature would do.
  const combines = feats.filter((f) => String(f.type).toLowerCase() === 'combine');
  if (combines.length >= 4) add('low', 'combine-chains', `${combines.length} combine features: bodies are built separately and merged afterwards.`, 'Create with operation: "join" or "cut" (and targets) so each feature adds to or cuts the part directly; it halves the timeline.');

  // Repeated geometry: same type and size made more than once.
  const sig = new Map();
  for (const f of feats) {
    const t = String(f.type).toLowerCase();
    if (!['box', 'cylinder', 'extrude', 'loft', 'revolve'].includes(t)) continue;
    if ((t === 'extrude' || t === 'revolve') && f.sketch === undefined) continue; // profiles differ; can't tell
    const key = JSON.stringify([t, f.length, f.width, f.height, f.radius, f.extent?.distance, f.sketch, f.profiles]);
    sig.set(key, [...(sig.get(key) || []), f]);
  }
  const dupes = [...sig.values()].filter((g) => g.length >= 2 && g[0].type !== 'loft');
  if (dupes.length) add('medium', 'repeats', `${dupes.length} shape${dupes.length > 1 ? 's are' : ' is'} built more than once with identical sizes.`, 'Build one, then solid.pattern.circular / linear or mirror it, so a change to one changes all.', dupes.map((g) => `${g.length}× ${g[0].type} ${g.map((f) => f.id).join(', ')}`));

  const bodies = new Set(feats.flatMap((f) => f.body_names || []));
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + ({ high: 25, medium: 12, low: 5 }[f.severity]), 0));
  return {
    score,
    summary: findings.length ? `${findings.length} thing${findings.length > 1 ? 's' : ''} to improve (score ${score}/100).` : 'Looks well built: named, parametric, no obvious repetition (score 100/100).',
    stats: { features: feats.length, parameters: userParams.length, dimensions: nDims, bodies: bodies.size },
    findings,
  };
}


// ---- expressions ----
const UNITS = new Set(['mm', 'cm', 'm', 'um', 'in', 'ft', 'deg', 'rad', 'pi', 'PI', 'e']);
const FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'exp', 'ln', 'log', 'log10', 'pow', 'if', 'sign', 'hypot', 'mod']);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** A quick well-formedness check of a parameter expression: tokens, operators and brackets in a
 *  sensible order, and names that exist. The modeller has the last word; this catches typos. */
export function checkExpr(expr, d, self = null) {
  const known = new Set([...(d.params || []).map((p) => p.name), ...(d.features || []).flatMap((f) => f.param_names || [])]);
  const toks = [];
  for (let i = 0; i < expr.length;) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/iy; num.lastIndex = i;
    if (/[\d.]/.test(c) && num.exec(expr)) { toks.push(['num']); i = num.lastIndex; continue; }
    IDENT.lastIndex = i;
    const id = IDENT.exec(expr);
    if (id) { toks.push(['id', id[0]]); i = IDENT.lastIndex; continue; }
    if ('+-*/^%'.includes(c)) { toks.push(['op', c]); i++; continue; }
    if (c === '(' || c === ')' || c === ',') { toks.push([c]); i++; continue; }
    if (c === '°') { toks.push(['id', 'deg']); i++; continue; }
    throw new Error(`"${expr}": unexpected "${c}".`);
  }
  let depth = 0, prev = null;
  for (const [k, v] of toks) {
    if (k === 'op') {
      if ((prev === null || prev === 'op' || prev === '(' || prev === ',') && v !== '-' && v !== '+') throw new Error(`"${expr}": "${v}" has nothing before it.`);
    } else if (k === '(') depth++;
    else if (k === ')') { if (--depth < 0 || prev === 'op' || prev === '(') throw new Error(`"${expr}": brackets don't match.`); }
    else if (k === 'id' && !UNITS.has(v) && !FUNCS.has(v) && !known.has(v)) {
      throw new Error(v === self ? `"${expr}": a parameter can't use itself.` : `"${expr}": no parameter "${v}". Parameters: ${[...known].filter((n) => !/^d\d+$/.test(n)).slice(0, 20).join(', ') || 'none yet'}.`);
    }
    prev = k === 'num' || k === 'id' ? 'val' : k;
  }
  if (depth !== 0) throw new Error(`"${expr}": brackets don't match.`);
  if (prev === 'op' || prev === null) throw new Error(`"${expr}": it ends with an operator.`);
}

/** Features and parameters whose expressions name `param`. */
export function usersOf(d, param) {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${param.replace(/[^A-Za-z0-9_]/g, '')}([^A-Za-z0-9_]|$)`);
  const hits = [];
  const walk = (v) => (typeof v === 'string' ? re.test(v) : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k !== 'name' && walk(x)) : false);
  for (const p of d.params || []) if (p.name !== param && re.test(String(p.expr))) hits.push(`parameter ${p.name}`);
  for (const f of d.features || []) if (walk({ ...f, name: undefined })) hits.push(`${f.id} ${f.name}`);
  return hits;
}
