// Three-way merge of SolidCraft design files (the JSON `document.export` gives).
//
// Keel syncs whole designs: each client sends its design text with the server sequence number it
// started from. When two people edit at once, the later one merges its change onto the newer
// design with this module, in the browser, and sends again. The same code runs in the Worker's
// tests. A design is `{format, name, units, params:[{name,...}], features:[{id,...}], next_id, ...}`.
//
// Rules:
// - Top-level fields: the side that changed it wins; if both did, mine (the later writer) wins.
// - Features are matched by `id`. A deletion beats a concurrent edit. Both sides editing one
//   feature merge field by field, mine winning a field both changed.
// - New features on both sides can take the same ids (each client numbers from `next_id`), so
//   mine are renumbered above theirs, with references to them inside my new features rewritten.
// - Dimension names (`param_names`, "d4") clash the same way and are renamed in my new features.
//
// `options.prefer` picks the winner of a field both sides changed: 'mine' (default) or 'theirs'.
// Every conflict is listed twice: `conflicts` as sentences, `details` as
// {path, kind: 'both-changed'|'deleted', base, mine, theirs, kept} for an agent or a UI to resolve.

export function mergeDesigns(baseText, mineText, theirsText, options = {}) {
  if (mineText === baseText) return { text: theirsText, conflicts: [], details: [], changed: false };
  if (theirsText === baseText || theirsText === mineText) return { text: mineText, conflicts: [], details: [], changed: false };
  const base = parse(baseText);
  const mine = parse(mineText);
  const theirs = parse(theirsText);
  const conflicts = Object.assign([], { prefer: options.prefer === 'theirs' ? 'theirs' : 'mine', details: [] });

  const out = {};
  const keys = new Set([...Object.keys(theirs), ...Object.keys(mine)]);
  for (const k of keys) {
    if (k === 'features' || k === 'params' || k === 'next_id') continue;
    const v = merge3(base[k], mine[k], theirs[k], k, conflicts);
    if (v !== undefined) out[k] = v;
  }

  // Renumber my new features whose ids theirs may also use.
  const baseIds = new Set((base.features || []).map((f) => f.id));
  const theirIds = new Set((theirs.features || []).map((f) => f.id));
  const myNew = (mine.features || []).filter((f) => !baseIds.has(f.id));
  const theirNew = (theirs.features || []).filter((f) => !baseIds.has(f.id));
  let nextId = Math.max(num(theirs.next_id), num(mine.next_id), num(base.next_id), ...[...theirIds].map((i) => i + 1), 1);
  const remap = new Map();
  if (theirNew.length) {
    for (const f of myNew) remap.set(f.id, nextId++);
  }
  const usedParams = new Set();
  for (const f of theirs.features || []) for (const p of f.param_names || []) usedParams.add(p);
  for (const p of theirs.params || []) if (p && p.name) usedParams.add(p.name);
  const paramRemap = new Map();
  const fresh = freshParam(usedParams, mine);
  for (const f of myNew) {
    for (const p of f.param_names || []) {
      if (usedParams.has(p) && !(base.features || []).some((b) => (b.param_names || []).includes(p))) {
        paramRemap.set(p, fresh());
      }
    }
  }
  const fixNew = (f) => (remap.size || paramRemap.size ? rewrite(f, remap, paramRemap) : f);
  const myNewFixed = new Map(myNew.map((f) => [f.id, fixNew(f)]));

  // Existing features, three-way.
  const byId = (list) => new Map((list || []).map((f) => [f.id, f]));
  const B = byId(base.features), M = byId(mine.features), T = byId(theirs.features);
  const merged = new Map();
  for (const [id, b] of B) {
    const m = M.get(id), t = T.get(id);
    if (!m || !t) {
      if ((m && !eq(m, b)) || (t && !eq(t, b))) deleted(conflicts, `feature ${id}`, b, m, t);
      continue;
    }
    merged.set(id, merge3(b, m, t, `feature ${id}`, conflicts));
  }
  for (const f of theirNew) merged.set(f.id, f);

  // Order: existing features in the order of whichever side reordered them (else mine), then
  // theirs' new features after the feature that preceded them, then mine after those.
  const theirsReordered = !sameOrder(base.features, theirs.features, B);
  const primary = theirsReordered ? theirs.features : mine.features;
  const order = (primary || []).filter((f) => baseIds.has(f.id) && merged.has(f.id)).map((f) => merged.get(f.id));
  const theirNewItems = new Set();
  const insertByAnchor = (list, pick, skipOver) => {
    let after = null; // the item the next new one follows (null: the start)
    for (const f of list || []) {
      const item = pick(f);
      if (item) {
        let at = after === null ? 0 : order.indexOf(after) + 1;
        while (skipOver && at < order.length && theirNewItems.has(order[at])) at++;
        order.splice(at, 0, item);
        after = item;
      } else if (baseIds.has(f.id) && merged.has(f.id)) {
        after = merged.get(f.id);
      }
    }
  };
  insertByAnchor(theirs.features, (f) => {
    if (baseIds.has(f.id)) return null;
    const item = merged.get(f.id);
    theirNewItems.add(item);
    return item;
  }, false);
  insertByAnchor(mine.features, (f) => myNewFixed.get(f.id) || null, true);

  out.params = mergeParams(base.params || [], mine.params || [], theirs.params || [], conflicts);
  out.features = order;
  out.next_id = Math.max(nextId, ...order.map((f) => num(f.id) + 1), 1);
  // Keep the file's key order as the engine writes it (cosmetic, but it keeps diffs readable).
  const ordered = {};
  for (const k of Object.keys(theirs)) if (k in out) ordered[k] = out[k];
  for (const k of Object.keys(out)) if (!(k in ordered)) ordered[k] = out[k];
  return { text: stringify(ordered), conflicts: [...conflicts], details: conflicts.details, changed: true, renumbered: [...remap] };
}

// Integers past 2^53 (hashes, seeds) don't survive JSON.parse, so they travel as tagged strings.
function parse(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, (_, pre, n) => `${pre}"\\u0000big:${n}"`));
}
function stringify(value) {
  return JSON.stringify(value, null, 2).replace(/"\\u0000big:(-?\d+)"/g, '$1');
}

function mergeParams(base, mine, theirs, conflicts) {
  const key = (p) => p && p.name;
  const B = new Map(base.map((p) => [key(p), p]));
  const M = new Map(mine.map((p) => [key(p), p]));
  const T = new Map(theirs.map((p) => [key(p), p]));
  const out = [];
  const seen = new Set();
  for (const p of theirs) {
    const k = key(p);
    seen.add(k);
    const b = B.get(k), m = M.get(k);
    if (b && !m) { if (!eq(p, b)) deleted(conflicts, `parameter ${k}`, b, m, p); continue; }
    out.push(b && m ? merge3(b, m, p, `parameter ${k}`, conflicts) : p);
  }
  for (const p of mine) {
    const k = key(p);
    if (seen.has(k)) continue;
    if (B.has(k)) { if (!eq(p, B.get(k))) deleted(conflicts, `parameter ${k}`, B.get(k), p, undefined); continue; }
    out.push(p); // new on my side
  }
  return out;
}

function merge3(b, m, t, path, conflicts) {
  if (eq(m, b)) return t;
  if (eq(t, b) || eq(m, t)) return m;
  if (isObj(b) && isObj(m) && isObj(t)) {
    const out = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
      const v = merge3(b[k], m[k], t[k], `${path}.${k}`, conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  const kept = conflicts.prefer;
  conflicts.push(`${path}: changed on both sides (kept ${kept})`);
  conflicts.details.push({ path, kind: 'both-changed', base: b, mine: m, theirs: t, kept });
  return kept === 'theirs' ? t : m;
}

// A deletion beats a concurrent edit (re-adding is easy; resurrecting half a feature isn't).
function deleted(conflicts, path, b, m, t) {
  conflicts.push(`${path}: deleted on one side, edited on the other (deleted)`);
  conflicts.details.push({ path, kind: 'deleted', base: b, mine: m ?? null, theirs: t ?? null, kept: 'deleted' });
}

// Keys whose integer values name a feature (or a sketch, which is a feature) in SolidCraft designs.
const REF_KEYS = new Set(['id', 'feature', 'feature_id', 'sketch', 'sketch_id', 'source', 'target', 'of', 'base', 'features', 'sketches', 'tool', 'tools', 'profile', 'path', 'rail', 'rails', 'guide', 'guides', 'axis_feature', 'plane_feature']);

function rewrite(value, remap, paramRemap, key = null, refCtx = false) {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, remap, paramRemap, key, refCtx));
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, remap, paramRemap, k, REF_KEYS.has(k));
    return out;
  }
  if (typeof value === 'number' && Number.isInteger(value) && refCtx && remap.has(value)) return remap.get(value);
  if (typeof value === 'string' && paramRemap.size) {
    if (paramRemap.has(value)) return paramRemap.get(value);
    if (key !== 'name' && key !== 'type') {
      return value.replace(/\b(d\d+)\b/g, (s) => paramRemap.get(s) || s);
    }
  }
  return value;
}

function freshParam(used, mine) {
  let n = 1;
  const all = new Set(used);
  for (const f of mine.features || []) for (const p of f.param_names || []) all.add(p);
  for (const p of all) { const m = /^d(\d+)$/.exec(p); if (m) n = Math.max(n, +m[1] + 1); }
  return () => { const name = `d${n++}`; used.add(name); return name; };
}

function sameOrder(baseList, otherList, B) {
  const a = (baseList || []).map((f) => f.id).filter((id) => (otherList || []).some((f) => f.id === id));
  const b = (otherList || []).map((f) => f.id).filter((id) => B.has(id));
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => eq(a[k], b[k]));
}
