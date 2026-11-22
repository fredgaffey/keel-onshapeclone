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

export const EDIT_OPS = ['set_parameter', 'delete_parameter', 'rename', 'suppress', 'delete', 'set', 'add', 'move', 'rename_design'];

const UNIT_RE = /^(mm|deg|)$/;

export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('Give a list of edits.');
  if (edits.length > 500) throw new Error('At most 500 edits at once.');
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

function setPath(obj, path, value) {
  const keys = Array.isArray(path) ? path : String(path).split('.').map((k) => (/^\d+$/.test(k) ? Number(k) : k));
  if (!keys.length || keys.some((k) => k === '' || k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error('Bad path.');
  if (keys[0] === 'id') throw new Error('A feature\'s id can\'t change.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') throw new Error(`"${keys.join('.')}" doesn't exist in this feature (stopped at "${k}").`);
    o = o[k];
  }
  const last = keys[keys.length - 1];
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
      const before = setPath(f, e.path, e.value);
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
