#!/usr/bin/env node
// Built from cli/keel.mjs by scripts/build-cli.mjs. Edit that, not this.
// keel: Keel documents and local SolidCraft design files (.sc), for people and AI agents.
// One file, no dependencies, Node 20+. Get it from any Keel site: curl -fsSLO https://<site>/keel.mjs
//
// Work on a Keel document as a local file:
//   keel pull <id|key> [file.sc]        save it to a file, linked to the document
//   keel push <file.sc> [--on-conflict mine|theirs|ask]
//                                       send your changes; merges with anyone editing live
//   keel status <file.sc>               unchanged, changed locally, changed remotely, or both
//   keel new <name> [--from file.sc] [--loose]
//                                       make a document (and link the file, given --from)
// No account: --loose (or no token) makes a loose document, reached only by the key it prints.
// It is DELETED 30 days after it's made (the site's setting). The key is kept next to the file.
//
// Local files only, no server:
//   keel merge <base.sc> <mine.sc> <theirs.sc> [-o out.sc] [--prefer mine|theirs]
//   keel check <file.sc>
//
// Account:  keel login --url https://<site> [--token keel_...] | logout | whoami | ls
// Other:    keel cat <id|key> | version <id|key> <name> | open <id|key>
//           keel host <id|key|file.sc>   open it in headless Chrome for agents: kernel checks,
//                                        screenshots and modelling commands (CHROME= to choose)
// Agents:   keel mcp    (an MCP server on stdio; Claude Code: claude mcp add keel -- node /path/to/keel.mjs mcp)
//
// The token comes from KEEL_TOKEN or ~/.config/keel/config.json (`keel login`, readable only by
// you). The site from KEEL_URL, the config, or a linked file. Never commit a token or a key.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
// ---- inlined from public/js/merge.js
const { mergeDesigns } = (() => {
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

function mergeDesigns(baseText, mineText, theirsText, options = {}) {
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
function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => eq(a[k], b[k]));
}

return { mergeDesigns, eq };
})();
// ---- inlined from public/js/agent-tools.js
const { TOOLS, DESIGN_NOTE, MODELLING_GUIDE, runTool, handleRpc } = (() => {
// The tools Keel offers AI agents, shared by the remote MCP endpoint (worker/mcp.js, at /mcp) and
// the local `keel mcp` server (public/keel.mjs). Both call Keel's HTTP API through `ctx.call`, so
// the rules (access, merging, limits) are the API's.
//
// ctx = {
//   call(path, {method, body, key}) -> data, throwing an Error with .status/.data on failure.
//     `key` is a loose document's key, used instead of the caller's own credentials.
//   site: 'https://keel.example.com',
//   signedIn: whether the caller has an account token (without one, only loose documents work),
//   reads?: Map, remembering what was read so a write can send its base text too,
//   asset(path) -> parsed JSON of a file the site serves (the format catalog),
// }

const MODELLING_GUIDE =
  'Model like a careful CAD engineer, not a script: ' +
  '(1) set_parameter the driving sizes first and use them in expressions; ' +
  '(2) give every feature a name for what it is ("Bore", "Blade clamp jaw"); ' +
  '(3) sketch on planes and extrude or revolve, with operation "join"/"cut" onto the part, rather than placing boxes with move and combining; ' +
  '(4) build a repeated or symmetric thing once, then pattern or mirror it; ' +
  '(5) after each step, screenshot and inspect_model; ' +
  '(6) before you finish, review_design and fix what it flags.';

const DESIGN_NOTE =
  'A design is SolidCraft JSON: {format, name, units, params:[{name, value...}], features:[{id, name, type, suppressed, ...}], next_id, ...}. ' +
  'Keep the format string as it is. New features take ids from next_id (then raise next_id), and each gets a short descriptive name ' +
  '("Mounting holes", not "Extrude 3"). Copy the shape of an existing feature of the same type when adding one.';

const ID = {
  type: 'string',
  description: 'The document id, or a loose document\'s key (keel_...). A key works without signing in.',
};

const TOOLS = [
  {
    name: 'list_documents',
    description: 'List the Keel documents you can open (needs an account token), newest first, with id, name, your role (owner, edit, view) and when each last changed.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_document',
    description: `Get a document's current design JSON and its seq (version counter); pass the seq to write_document as base_seq. ${DESIGN_NOTE}`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_document',
    description:
      'Save an edited design. It applies on top of base_seq (the seq you read) and merges with anything changed since. ' +
      'A field both you and someone else changed is a conflict: on_conflict "mine" (default) keeps yours, "theirs" keeps theirs, ' +
      '"ask" saves nothing and returns each conflict (base, mine, theirs) with the current design, so you can resolve them and write again with the new base_seq. ' +
      'People with the document open see the change live.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        design: { type: 'string', description: 'The whole design JSON, as text.' },
        base_seq: { type: 'integer', description: 'The seq the design was read at.' },
        on_conflict: { type: 'string', enum: ['mine', 'theirs', 'ask'] },
        check: { type: 'boolean', description: 'After saving, rebuild it with the real kernel and report errors (see inspect_model).' },
      },
      required: ['id', 'design', 'base_seq'],
    },
  },
  {
    name: 'create_document',
    description:
      'Create a document, empty or from design JSON. With an account token it goes in your documents. ' +
      'With loose: true, or without signing in, it is a loose document: no account, and the result has a key (keel_...) ' +
      'that is the only way back in. Keep the key (it is a password for that document, and is shown once), for example next to your local copy. ' +
      `Loose documents are deleted a set number of days after they are made (30 on keel.pebnum.com; the result gives the date). ${DESIGN_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, design: { type: 'string' }, loose: { type: 'boolean' }, by: { type: 'string', description: 'For loose documents: the name shown to people who open it, e.g. "Claude".' } },
      required: ['name'],
    },
  },
  {
    name: 'edit_document',
    description:
      'Make small typed changes without sending the whole design. Applied to the current design, so they never conflict. Edits run in order; features are named by id or exact name. Ops: ' +
      'set_parameter {name, expr ("25 mm", "width / 2"), unit?}, delete_parameter {name}, rename {feature, name}, suppress {feature, suppressed?}, delete {feature}, ' +
      'set {feature, path ("depth" or "extent.distance"), value, create?} (an unknown path is refused unless create: true), add {feature: {type, name?, ...fields}, after?} (id and a unique name are filled in), move {feature, after}, rename_design {name}, auto_name {} (names features still called "Box3" from what they do). ' +
      'Parameter expressions are checked (names must exist; "+*" is refused), and a parameter in use can\'t be deleted. ' +
      'check: true then rebuilds it in a browser tab with the real kernel and reports errors (needs a tab open on the document; see inspect_model).',
    inputSchema: {
      type: 'object',
      properties: { id: ID, edits: { type: 'array', items: { type: 'object' } }, check: { type: 'boolean' } },
      required: ['id', 'edits'],
    },
  },
  {
    name: 'review_design',
    description: 'Mark a design the way a CAD reviewer would, with a score: default feature names, no parameters, numbers typed into many features, computed placements, combine chains, shapes built twice instead of patterned. Each finding says how to fix it. Run it before you call a design done.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_changes',
    description: 'What changed in a document since a seq (one of the last 50 changes): features added, removed and renamed, each changed field with before and after, and parameters. Much smaller than reading the whole design.',
    inputSchema: { type: 'object', properties: { id: ID, since_seq: { type: 'integer' } }, required: ['id', 'since_seq'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'inspect_model',
    description:
      'Rebuild check by the real modelling kernel: each feature with its error or warning, the bodies, parameters, and optionally volumes and areas (measure: true). ' +
      'Runs in a browser tab that has the document open with agents allowed (on by default), or one started with `keel host`. at_seq (from a write) waits until the tab has at least that version. params: true includes the parameters and their values.',
    inputSchema: { type: 'object', properties: { id: ID, measure: { type: 'boolean' }, at_seq: { type: 'integer' }, params: { type: 'boolean' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'screenshot',
    description: 'A picture of the model as rendered by the modeller, from a browser tab on the document (see inspect_model). view (iso, front, back, top, bottom, left, right, home, fit) turns to that view and frames the model; without it, the view as it is. The picture is the 3D view only; chrome: true includes the app around it. at_seq waits until the tab has at least that version (it always shows the latest).',
    inputSchema: { type: 'object', properties: { id: ID, view: { type: 'string', enum: ['iso', 'front', 'back', 'top', 'bottom', 'left', 'right', 'home', 'fit'] }, at_seq: { type: 'integer' }, chrome: { type: 'boolean' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_commands',
    description: 'Search SolidCraft\'s modelling commands (about 620: sketch.*, solid.*, sheet metal, patterns...), with their parameters, for run_commands. Give a filter such as "extrude", "fillet" or "sketch.rect".',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'describe_format',
    description: 'The design format reference: with no topic, an overview and the list of worked examples; with a topic ("extrude", "sketch", "fillet", "revolve", "pattern"...), the matching examples (the commands that make them, tested, and the features they produce in the design JSON) and commands. Read this before writing features by hand.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_commands',
    description:
      'Model with SolidCraft\'s own commands, run by the real kernel in a browser tab on the document; the result syncs to everyone like a person\'s edit. ' +
      'commands: [{command, params}] (see list_commands), run as one batch: if one fails, the batch is undone (rollback) and the failure is returned. ' +
      'Name what you make: most create commands take name and body_name ("Mounting plate", not "Extrude1"); anything left unnamed is named automatically from what it does. Use parameter expressions for sizes. screenshot: a view name to get a picture afterwards. ' + MODELLING_GUIDE,
    inputSchema: {
      type: 'object',
      properties: { id: ID, commands: { type: 'array', items: { type: 'object' } }, screenshot: { type: 'string' } },
      required: ['id', 'commands'],
    },
  },
  {
    name: 'save_version',
    description: 'Save a named version of a document, which can be restored from the Versions panel. Good before and after a large change.',
    inputSchema: { type: 'object', properties: { id: ID, name: { type: 'string' } }, required: ['id', 'name'] },
  },
  {
    name: 'restore_version',
    description: 'Put a document back to a saved version (from list_versions): everyone sees it at once. The current state is kept as a new version first, so this can be undone too.',
    inputSchema: { type: 'object', properties: { id: ID, version: { type: 'string', description: 'The version id from list_versions.' } }, required: ['id', 'version'] },
  },
  {
    name: 'list_versions',
    description: 'List a document\'s saved versions (named and automatic), newest first.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
];

const isKey = (s) => typeof s === 'string' && s.startsWith('keel_');

// A loose key stands for its document: find which one.
async function target(ctx, ref) {
  if (!ref || typeof ref !== 'string') throw new Error('Give the document id or key.');
  if (!isKey(ref)) {
    if (!ctx.signedIn) throw new Error('Without an account token, only loose documents work: give the document\'s key (keel_...) instead of its id.');
    return { id: ref, key: null };
  }
  const { user } = await ctx.call('/me', { key: ref });
  if (!user.token?.document_id) throw new Error('That is an account token, not a document key. Give a document id.');
  return { id: user.token.document_id, key: ref };
}

function openUrl(ctx, id, key) {
  return `${ctx.site}/d/${id}${key ? `#key=${key}` : ''}`;
}

function checkDesign(text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error(`The design isn't valid JSON: ${e.message}`); }
  if (!d || typeof d.format !== 'string' || !Array.isArray(d.features)) throw new Error('That isn\'t a SolidCraft design: it needs a "format" string and a "features" list.');
}

async function runTool(ctx, name, a = {}) {
  switch (name) {
    case 'list_documents': {
      if (!ctx.signedIn) throw new Error('Listing documents needs an account token. Loose documents are reached by their key.');
      const { documents } = await ctx.call('/docs');
      return documents.map((d) => ({ id: d.id, name: d.name, role: d.role, owner: d.owner_name, updated: new Date(d.updated_at).toISOString(), url: openUrl(ctx, d.id) }));
    }
    case 'read_document': {
      const t = await target(ctx, a.id);
      const [{ document: doc }, c] = await Promise.all([ctx.call(`/docs/${t.id}`, { key: t.key }), ctx.call(`/docs/${t.id}/content`, { key: t.key })]);
      ctx.reads?.set(t.id, { seq: c.seq, text: c.text });
      return `Document "${doc.name}" (id ${t.id}, seq ${c.seq}, your role: ${doc.role}, last changed by ${c.by || 'unknown'}). Pass base_seq ${c.seq} when writing.\n${c.text}`;
    }
    case 'write_document': {
      if (a.design && typeof a.design === 'object') a.design = JSON.stringify(a.design, null, 2);
      checkDesign(a.design);
      const t = await target(ctx, a.id);
      if (!Number.isInteger(a.base_seq)) throw new Error('Give base_seq: the seq you read the design at (read_document shows it).');
      const known = ctx.reads?.get(t.id);
      const body = { base: a.base_seq, text: a.design, on_conflict: a.on_conflict || 'mine', ...(known && known.seq === a.base_seq ? { base_text: known.text } : {}) };
      let r;
      try {
        r = await ctx.call(`/docs/${t.id}/content`, { method: 'PUT', body, key: t.key });
      } catch (e) {
        if (e.status !== 409) throw e;
        const d = e.data || {};
        if (d.current) ctx.reads?.set(t.id, { seq: d.current.seq, text: d.current.text });
        return {
          saved: false,
          reason: d.error || e.message,
          ...(d.conflicts ? { conflicts: d.conflicts } : {}),
          current_seq: d.current?.seq,
          current_design: d.current?.text,
          ...(d.merged_text ? { merged_design_keeping_yours: d.merged_text } : {}),
          next: `Fix the design, then call write_document again with base_seq ${d.current?.seq}.`,
        };
      }
      ctx.reads?.set(t.id, { seq: r.seq, text: r.text ?? a.design });
      const check = a.check ? await inspect(ctx, t, { at_seq: r.seq }).catch((e) => ({ unavailable: e.message })) : undefined;
      return {
        saved: !r.unchanged, seq: r.seq, merged: r.merged, conflicts: r.conflicts, ...(check ? { check } : {}),
        ...(r.merged ? { note: `The document changed after version ${a.base_seq}${r.merged_with ? ` (last by ${r.merged_with})` : ''}; those changes were merged with yours. read_document shows the result.` } : {}),
        url: openUrl(ctx, t.id, t.key),
      };
    }
    case 'create_document': {
      if (a.design) checkDesign(a.design);
      if (a.loose || !ctx.signedIn) {
        const r = await ctx.call('/loose', { method: 'POST', body: { name: a.name, text: a.design, by: a.by } });
        return {
          id: r.document.id, name: r.document.name, key: r.key, url: r.url,
          note: 'Loose document: keep the key, it is the only way back in and it is not shown again. Use it as the id in other tools. Anyone with the url can edit.',
        };
      }
      const { document: d } = await ctx.call('/docs', { method: 'POST', body: { name: a.name, ...(a.design ? { text: a.design } : {}) } });
      return { id: d.id, name: d.name, url: openUrl(ctx, d.id) };
    }
    case 'edit_document': {
      const t = await target(ctx, a.id);
      const r = await ctx.call(`/docs/${t.id}/edit`, { method: 'POST', body: { edits: a.edits }, key: t.key });
      const out = { saved: !r.unchanged, seq: r.seq, done: r.done };
      if (a.check && !r.unchanged) out.check = await inspect(ctx, t, { at_seq: r.seq }).catch((e) => ({ unavailable: e.message }));
      return out;
    }
    case 'review_design': {
      const t = await target(ctx, a.id);
      return ctx.call(`/docs/${t.id}/review`, { key: t.key });
    }
    case 'get_changes': {
      const t = await target(ctx, a.id);
      return ctx.call(`/docs/${t.id}/changes?since=${encodeURIComponent(a.since_seq)}`, { key: t.key });
    }
    case 'inspect_model': {
      const t = await target(ctx, a.id);
      return inspect(ctx, t, a);
    }
    case 'screenshot': {
      const t = await target(ctx, a.id);
      const r = await run(ctx, t, [{ method: 'keel.screenshot', params: { view: a.view, chrome: !!a.chrome } }], a.at_seq);
      const shot = r.results[0];
      return { __content: [{ type: 'image', data: shot.image, mimeType: shot.mime }, { type: 'text', text: `${shot.width}×${shot.height}, document seq ${r.seq}, from ${r.host}'s tab.` }] };
    }
    case 'list_commands': {
      const cat = await catalog(ctx);
      const f = String(a.filter || '').toLowerCase();
      const hits = cat.commands.filter((c) => `${c.id} ${c.label}`.toLowerCase().includes(f));
      return { matches: hits.length, commands: hits.slice(0, 40), ...(hits.length > 40 ? { note: 'Showing 40; narrow the filter.' } : {}) };
    }
    case 'describe_format': {
      const cat = await catalog(ctx);
      const topic = String(a.topic || '').toLowerCase().trim();
      if (!topic) {
        const families = {};
        for (const c of cat.commands) { const fam = c.id.split('.')[0]; families[fam] = (families[fam] || 0) + 1; }
        return { format: cat.format, how_to_model: MODELLING_GUIDE, note: DESIGN_NOTE, examples: Object.keys(cat.examples), command_families: families, next: 'describe_format with a topic shows examples; list_commands searches commands.' };
      }
      const examples = Object.entries(cat.examples).filter(([k, v]) => k.includes(topic) || JSON.stringify(v.commands).toLowerCase().includes(topic) || v.features.some((f) => String(f.type).toLowerCase().includes(topic)));
      const commands = cat.commands.filter((c) => c.id.toLowerCase().includes(topic)).slice(0, 15);
      return { format: cat.format, examples: Object.fromEntries(examples), commands, ...(examples.length || commands.length ? {} : { note: `Nothing about "${topic}". Examples: ${Object.keys(cat.examples).join(', ')}.` }) };
    }
    case 'run_commands': {
      const t = await target(ctx, a.id);
      if (!Array.isArray(a.commands) || !a.commands.length) throw new Error('Give commands: [{command, params}].');
      const calls = [{ method: 'engine.batch', params: { commands: a.commands.map((c) => ({ command: c.command ?? c.id, params: c.params ?? {} })), rollback: true } }];
      if (a.screenshot) calls.push({ method: 'keel.screenshot', params: { view: a.screenshot } });
      const r = await run(ctx, t, calls, null, { allowFail: true });
      const batch = r.results[0];
      if (r.ok && !batch?.failed && r.saved) {
        // Name what the commands made (where the agent didn't): applied by the room, merged live.
        await ctx.call(`/docs/${t.id}/edit`, { method: 'POST', body: { edits: [{ op: 'auto_name' }] }, key: t.key }).catch(() => {});
      }
      const failed = batch?.failed || r.failed;
      const brief = (x) => (x && typeof x === 'object' ? Object.fromEntries(['feature', 'name', 'bodies', 'created_bodies', 'removed_bodies', 'warning'].filter((k) => x[k] !== undefined && x[k] !== null && !(Array.isArray(x[k]) && !x[k].length)).map((k) => [k, x[k]])) : x);
      const text = failed
        ? { ok: false, rolled_back: true, failed, note: 'Nothing was kept: the whole batch was undone. Fix the failing command and run the batch again.', seq: r.seq }
        : { ok: !!r.ok, seq: r.seq, saved: r.saved, completed: batch?.completed, results: (batch?.results || []).map(brief), ...(r.error ? { error: r.error } : {}) };
      const shot = r.results[1];
      if (shot?.image) return { __content: [{ type: 'text', text: JSON.stringify(text, null, 2) }, { type: 'image', data: shot.image, mimeType: shot.mime }] };
      return text;
    }
    case 'save_version': {
      const t = await target(ctx, a.id);
      return ctx.call(`/docs/${t.id}/versions`, { method: 'POST', body: { name: a.name }, key: t.key });
    }
    case 'restore_version': {
      const t = await target(ctx, a.id);
      await ctx.call(`/docs/${t.id}/versions`, { method: 'POST', body: { name: 'Before restoring a version' }, key: t.key }).catch(() => {});
      return ctx.call(`/docs/${t.id}/versions/${encodeURIComponent(a.version)}/restore`, { method: 'POST', body: {}, key: t.key });
    }
    case 'list_versions': {
      const t = await target(ctx, a.id);
      return ctx.call(`/docs/${t.id}/versions`, { key: t.key });
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// The format reference (public/agents/catalog.json, built by scripts/feature-catalog.mjs).
let catalogCache = null;
async function catalog(ctx) {
  if (!catalogCache) catalogCache = ctx.asset('/agents/catalog.json').catch((e) => { catalogCache = null; throw e; });
  return catalogCache;
}

// Calls run by a browser tab on the document (DocRoom /run).
async function run(ctx, t, calls, at_seq = null, { allowFail = false } = {}) {
  const r = await ctx.call(`/docs/${t.id}/run`, { method: 'POST', body: { calls, at_seq, timeout_ms: 90_000 }, key: t.key });
  if (!r.ok && !allowFail) throw new Error(r.error || (r.failed ? `${r.failed.method} failed: ${r.failed.error}` : 'The browser tab could not run that.'));
  return r;
}

async function inspect(ctx, t, { measure = false, at_seq = null, params = false } = {}) {
  const r = await run(ctx, t, [{ method: 'document.inspect', params: { timeline: 'summary', bodies: measure ? true : 'names', measure: !!measure } }], at_seq, { allowFail: true });
  if (r.opens === false) return { seq: r.seq, rebuilds: false, opens: false, error: r.error, next: 'Fix the design (or write the previous one back), then check again.' };
  if (!r.ok) throw new Error(r.error || 'The browser tab could not inspect the model.');
  const d = r.results[0] || {};
  const timeline = d.timeline || [];
  const problems = timeline.filter((f) => f.error || f.warning).map((f) => ({ id: f.id, name: f.name, type: f.type, ...(f.error ? { error: f.error } : {}), ...(f.warning ? { warning: f.warning } : {}) }));
  return {
    seq: r.seq,
    rebuilds: !problems.some((p) => p.error),
    problems,
    features: timeline.map((f) => `${f.id} ${f.name} (${f.type})${f.suppressed ? ' suppressed' : ''}${f.rolled_back ? ' rolled back' : ''}`),
    bodies: d.bodies,
    ...(params ? { params: d.params } : {}),
    units: d.units,
  };
}

// One MCP JSON-RPC message in, one reply out (null for notifications).
async function handleRpc(msg, { ctx, tools = TOOLS, run = (n, a) => runTool(ctx, n, a), info, instructions }) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') {
      return ok({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: info, instructions });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools });
    if (method === 'tools/call') {
      try {
        const out = await run(params.name, params.arguments || {});
        if (out && out.__content) return ok({ content: out.__content });
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
  }
}

return { MODELLING_GUIDE, DESIGN_NOTE, TOOLS, openUrl, runTool, handleRpc };
})();

const VERSION = '0.2.0';
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'keel', 'config.json');
const DEFAULT_SITE = 'https://keel.pebnum.com';

// ---------------------------------------------------------------- config and HTTP

function loadConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch {}
  const url = (process.env.KEEL_URL || file.url || DEFAULT_SITE).replace(/\/+$/, '');
  const token = process.env.KEEL_TOKEN || file.token || '';
  return { url, token };
}

class KeelError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

const isKey = (s) => typeof s === 'string' && s.startsWith('keel_');

// `key` (a loose document's) replaces the account token; `site` overrides the configured site.
async function call(path, { method = 'GET', body, key, site } = {}) {
  const cfg = loadConfig();
  const url = (site || cfg.url).replace(/\/+$/, '');
  const token = key || cfg.token;
  let res;
  try {
    res = await fetch(url + '/api' + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new KeelError(`Can't reach ${url}: ${e.cause?.message || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 401 && !token ? ' Sign in with `keel login`, or use a loose document\'s key.' : '';
    throw new KeelError((data.error || `${res.status} ${res.statusText}`) + hint, res.status, data);
  }
  return data;
}

// Which document an id or key means: {id, key}.
async function target(ref, site) {
  if (!isKey(ref)) return { id: ref, key: null };
  const { user } = await call('/me', { key: ref, site });
  if (!user.token?.document_id) throw new KeelError('That is an account token, not a document key.');
  return { id: user.token.document_id, key: ref };
}

const docUrl = (site, id, key) => `${site}/d/${id}${key ? `#key=${key}` : ''}`;
const deletion = (t) => (t ? `It will be DELETED on ${new Date(t).toLocaleString()}.` : '');

// ---------------------------------------------------------------- linked files
// Next to `Part.sc` lives `.Part.sc.keel`: the site, the document, its key if loose, and the design
// as last pulled or pushed (the base the next merge starts from). It holds the key: keep it private.

const sidecar = (file) => join(dirname(file), `.${basename(file)}.keel`);
const safeName = (name) => String(name || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Untitled';

function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

function readLink(file) {
  try { return JSON.parse(readFileSync(sidecar(file), 'utf8')); } catch {
    throw new KeelError(`${file} isn't linked to a Keel document. \`keel pull <id> ${basename(file)}\` gets one; \`keel new <name> --from ${basename(file)}\` uploads this one.`);
  }
}
const writeLink = (file, link) => writeAtomic(sidecar(file), JSON.stringify(link), 0o600);

function checkDesign(text, where = 'design') {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new KeelError(`${where} isn't valid JSON: ${e.message}`); }
  if (!d || typeof d.format !== 'string' || !Array.isArray(d.features)) throw new KeelError(`${where} isn't a SolidCraft design (it needs a "format" string and a "features" list).`);
  return d;
}

// Bring a linked file up to date with the document. Local changes are kept: merged onto the newer
// design (prefer decides fields both changed), so the file then holds changes still to push.
async function pull(ref, file, { force = false, prefer = 'mine' } = {}) {
  let link = null;
  if (file && existsSync(resolve(file))) { try { link = readLink(resolve(file)); } catch {} }
  const site = link?.url || loadConfig().url;
  const t = ref ? await target(ref, site) : { id: link?.id, key: link?.key || null };
  if (!t.id) throw new KeelError('Which document? Give its id or key.');
  const [{ document: doc }, content] = await Promise.all([call(`/docs/${t.id}`, { key: t.key, site }), call(`/docs/${t.id}/content`, { key: t.key, site })]);
  file = resolve(file || `${safeName(doc.name)}.sc`);
  let text = content.text, conflicts = [], merged = false;
  if (existsSync(file) && !force) {
    if (!link) try { link = readLink(file); } catch {}
    if (!link || link.id !== t.id) throw new KeelError(`${file} exists and isn't linked to this document. Choose another file name, or pass --force to overwrite it.`);
    const local = readFileSync(file, 'utf8');
    if (local !== link.base && local !== content.text) {
      checkDesign(local, file);
      const m = mergeDesigns(link.base, local, content.text, { prefer: prefer === 'theirs' ? 'theirs' : 'mine' });
      text = m.text; conflicts = m.details; merged = true;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, text);
  writeLink(file, { url: site, id: t.id, key: t.key || link?.key || null, name: doc.name, seq: content.seq, base: content.text, expires_at: doc.expires_at || null });
  return { file, id: t.id, name: doc.name, seq: content.seq, role: doc.role, merged, unpushed: text !== content.text, conflicts, expires_at: doc.expires_at || null };
}

async function push(file, { onConflict = 'mine' } = {}) {
  file = resolve(file);
  const link = readLink(file);
  const text = readFileSync(file, 'utf8');
  if (text === link.base) return { file, id: link.id, seq: link.seq, unchanged: true, merged: false, conflicts: [] };
  checkDesign(text, file);
  let r;
  try {
    r = await call(`/docs/${link.id}/content`, { method: 'PUT', key: link.key, site: link.url, body: { base: link.seq, text, base_text: link.base, on_conflict: onConflict } });
  } catch (e) {
    if (e.status === 409 && e.data?.conflicts) {
      // 'ask': nothing saved. Merge here instead, keeping mine, so the file sits on the newest
      // design with the clashes listed; the agent or person fixes them and pushes again.
      const p = await pull(null, file, { prefer: 'mine' });
      return { file, id: link.id, seq: p.seq, saved: false, needsResolving: true, conflicts: p.conflicts };
    }
    throw e;
  }
  const final = r.text ?? text; // when merged, the server sends the merged design back
  if (final !== text) writeAtomic(file, final);
  writeLink(file, { ...link, seq: r.seq, base: final });
  return { file, id: link.id, seq: r.seq, saved: !r.unchanged, unchanged: !!r.unchanged, merged: r.merged, conflicts: r.conflicts || [] };
}

async function status(file) {
  file = resolve(file);
  const link = readLink(file);
  const local = readFileSync(file, 'utf8');
  const c = await call(`/docs/${link.id}/content`, { key: link.key, site: link.url });
  const mine = local !== link.base, theirs = c.seq !== link.seq;
  return { file, id: link.id, local_changes: mine, remote_changes: theirs, seq: link.seq, remote_seq: c.seq, url: docUrl(link.url, link.id), ...(link.key ? { key_in: sidecar(file) } : {}), expires_at: link.expires_at,
    state: mine && theirs ? 'both changed: `keel pull` merges them, then push' : mine ? 'changed locally: push to send' : theirs ? 'changed remotely: pull to update' : 'up to date' };
}

// Upload a local file as a new document and link it.
async function create(name, { from, loose = false, by } = {}) {
  const cfg = loadConfig();
  const text = from ? readFileSync(from, 'utf8') : undefined;
  if (text) checkDesign(text, from);
  let id, key = null, expires = null, note = '';
  if (loose || !cfg.token) {
    const r = await call('/loose', { method: 'POST', key: null, body: { name, text, by } });
    ({ id } = r.document); key = r.key; expires = r.document.expires_at; note = r.note;
  } else {
    ({ id } = (await call('/docs', { method: 'POST', body: { name, ...(text ? { text } : {}) } })).document);
  }
  let file = null;
  if (from) {
    file = resolve(from);
    const c = await call(`/docs/${id}/content`, { key, site: cfg.url });
    writeLink(file, { url: cfg.url, id, key, name, seq: c.seq, base: text, expires_at: expires });
  }
  return { id, name, key, url: docUrl(cfg.url, id, key), file, expires_at: expires, note };
}

// ---------------------------------------------------------------- agent host
// A headless Chrome with the document open in host mode (/d/<id>?host=1), so agents' kernel
// checks, screenshots and modelling commands have a tab to run in. It runs until stopped.

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new KeelError('No Chrome found. Install Chrome or Chromium, or set CHROME to its path.');
  return hit;
}

async function host(ref, { detached = false } = {}) {
  let site = loadConfig().url, id, key;
  if (ref && ref.endsWith('.sc') && existsSync(sidecar(resolve(ref)))) {
    const link = readLink(resolve(ref));
    ({ id } = link); key = link.key; site = link.url;
  } else {
    if (!ref) throw new KeelError('Which document? Give its id, key or linked file.');
    ({ id, key } = await target(ref, site));
  }
  const credential = key || loadConfig().token;
  if (!credential) throw new KeelError('Hosting an account document needs a token: run `keel login` or set KEEL_TOKEN.');
  const url = `${site}/d/${id}?host=1#key=${credential}`;
  const profile = join(tmpdir(), `keel-host-${id}`);
  mkdirSync(profile, { recursive: true });
  const chrome = findChrome();
  const child = spawn(chrome, ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1400,900', url], { detached, stdio: 'ignore' });
  if (detached) child.unref();
  return { id, pid: child.pid, chrome, child, url: `${site}/d/${id}` };
}

// ---------------------------------------------------------------- command line

const HELP = (() => {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const top = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
  return top.filter((l) => !l.startsWith('// Built from')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
})();

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a === '-o') {
      const [k, v] = (a === '-o' ? 'out' : a.slice(2)).split('=', 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function showConflicts(list) {
  for (const c of list) {
    if (c.kind === 'deleted') console.log(`  conflict  ${c.path}: deleted on one side, edited on the other (it stays deleted)`);
    else console.log(`  conflict  ${c.path}: base ${short(c.base)}, mine ${short(c.mine)}, theirs ${short(c.theirs)} (kept ${c.kept})`);
  }
}
const short = (v) => { const s = JSON.stringify(v); return s === undefined ? 'none' : s.length > 60 ? s.slice(0, 57) + '...' : s; };

async function cli(argv) {
  const f = flags(argv);
  const [cmd, ...args] = f._;
  const need = (n, usage) => { if (args.length < n) throw new KeelError(`Usage: keel ${usage}`); };
  const cfg = loadConfig();
  switch (cmd) {
    case 'login': {
      const url = String(f.url || cfg.url).replace(/\/+$/, '');
      let token = typeof f.token === 'string' ? f.token : '';
      if (!token) {
        process.stderr.write(`Paste an API token from ${url} (your name, top right → API tokens): `);
        token = (await new Promise((res) => createInterface({ input: process.stdin }).once('line', res))).trim();
      }
      const res = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } }).catch((e) => { throw new KeelError(`Can't reach ${url}: ${e.message}`); });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KeelError(data.error || `HTTP ${res.status}`);
      mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
      const u = data.user;
      console.log(`Signed in to ${url} as ${u.name}, with the token "${u.token?.name}" (${u.token?.scope === 'read' ? 'read-only' : 'read and write'}). Saved to ${CONFIG}.`);
      return;
    }
    case 'logout':
      if (existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify({ url: cfg.url }, null, 2) + '\n', { mode: 0o600 });
      console.log('Removed the token from this computer. It works until you revoke it on the website.');
      return;
    case 'whoami': {
      if (!cfg.token) return console.log(`Not signed in to ${cfg.url}. Loose documents still work.`);
      const { user: u } = await call('/me');
      console.log(`${u.name} <${u.email}> on ${cfg.url}, token "${u.token?.name}" (${u.token?.scope})`);
      return;
    }
    case 'ls': case 'list': {
      const { documents } = await call('/docs');
      if (f.json) return console.log(JSON.stringify(documents, null, 2));
      if (!documents.length) return console.log('No documents yet. `keel new "My part"` makes one.');
      for (const d of documents) console.log(`${d.id}  ${d.role.padEnd(5)}  ${new Date(d.updated_at).toLocaleString().padEnd(22)}  ${d.name}`);
      return;
    }
    case 'pull': {
      need(1, 'pull <id|key|file.sc> [file.sc] [--force] [--prefer mine|theirs]');
      const linked = args[0].endsWith('.sc') && existsSync(sidecar(resolve(args[0])));
      const r = linked ? await pull(null, args[0], { prefer: f.prefer }) : await pull(args[0], args[1], { force: !!f.force, prefer: f.prefer });
      console.log(`${r.file}: "${r.name}" at seq ${r.seq}${r.role === 'view' ? ', view only' : ''}.`);
      if (r.merged) console.log('Your local changes were kept, merged onto the newer design. Push to send them.');
      showConflicts(r.conflicts);
      if (r.expires_at) console.log(`Loose document. ${deletion(r.expires_at)}`);
      return;
    }
    case 'push': {
      need(1, 'push <file.sc> [--on-conflict mine|theirs|ask]');
      const r = await push(args[0], { onConflict: f['on-conflict'] || 'mine' });
      if (r.unchanged) return console.log('No changes to send.');
      if (r.needsResolving) {
        console.log(`Not sent: these clash with changes made since your last pull. ${r.file} now holds the newest design with your changes merged in (yours kept for each clash below). Fix what you want, then push again.`);
        showConflicts(r.conflicts);
        process.exitCode = 3;
        return;
      }
      const link = readLink(resolve(args[0]));
      console.log(`Sent. Now at seq ${r.seq}: ${docUrl(link.url, link.id)}`);
      if (r.merged) console.log(`Someone else changed it meanwhile; merged, and ${r.file} now holds the merged design.`);
      showConflicts(r.conflicts);
      return;
    }
    case 'status': {
      need(1, 'status <file.sc>');
      const s = await status(args[0]);
      console.log(`${s.file}: ${s.state} (local seq ${s.seq}, document seq ${s.remote_seq})\n${s.url}${s.expires_at ? `\nLoose document. ${deletion(s.expires_at)}` : ''}`);
      return;
    }
    case 'new': {
      need(1, 'new <name> [--from file.sc] [--loose] [--by "Name"]');
      const r = await create(args[0], { from: f.from, loose: !!f.loose, by: f.by });
      console.log(`Created "${r.name}": ${r.id}\n${r.url}`);
      if (r.key) console.log(`Key (the only way back in; shown once${r.file ? ', also saved next to the file' : ''}): ${r.key}\n${r.note}`);
      if (r.file) console.log(`${r.file} is linked to it: edit, then \`keel push ${basename(r.file)}\`.`);
      return;
    }
    case 'cat': { need(1, 'cat <id|key>'); const t = await target(args[0]); process.stdout.write((await call(`/docs/${t.id}/content`, { key: t.key })).text + '\n'); return; }
    case 'version': {
      need(2, 'version <id|key> <name>');
      const t = await target(args[0]);
      const v = await call(`/docs/${t.id}/versions`, { method: 'POST', key: t.key, body: { name: args.slice(1).join(' ') } });
      console.log(`Saved version "${v.name}" at seq ${v.seq}.`);
      return;
    }
    case 'open': { need(1, 'open <id|key>'); const t = await target(args[0]); console.log(docUrl(cfg.url, t.id, t.key)); return; }
    case 'merge': {
      need(3, 'merge <base.sc> <mine.sc> <theirs.sc> [-o out.sc] [--prefer mine|theirs]');
      const [b, m, t] = args.map((p) => readFileSync(p, 'utf8'));
      args.forEach((p, i) => checkDesign([b, m, t][i], p));
      const r = mergeDesigns(b, m, t, { prefer: f.prefer === 'theirs' ? 'theirs' : 'mine' });
      if (typeof f.out === 'string') { writeAtomic(resolve(f.out), r.text); console.log(`Merged into ${f.out}.`); } else process.stdout.write(r.text + '\n');
      if (r.details.length) { console.error(`${r.details.length} conflict(s):`); showConflicts(r.details); process.exitCode = 3; }
      return;
    }
    case 'check': {
      need(1, 'check <file.sc>');
      const d = checkDesign(readFileSync(args[0], 'utf8'), args[0]);
      const ids = d.features.map((x) => x.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
      const unnamed = d.features.filter((x) => !x.name).map((x) => x.id);
      const low = d.features.filter((x) => Number.isInteger(x.id) && x.id >= (d.next_id || 0)).map((x) => x.id);
      console.log(`${args[0]}: ${d.format}, ${d.features.length} features, ${(d.params || []).length} parameters.`);
      if (dup.length) console.log(`  duplicate feature ids: ${[...new Set(dup)].join(', ')}`);
      if (low.length) console.log(`  next_id (${d.next_id}) must be above every feature id; these aren't below it: ${low.join(', ')}`);
      if (unnamed.length) console.log(`  features without a name: ${unnamed.join(', ')}`);
      if (dup.length || low.length) process.exitCode = 3;
      console.log('This checks the file\'s structure only. Opening it in SolidCraft (or `solidcraft-cli`) rebuilds it with the real kernel.');
      return;
    }
    case 'host': {
      need(1, 'host <id|key|file.sc>');
      const h = await host(args[0]);
      console.log(`Hosting ${h.url} for agents in headless Chrome (pid ${h.pid}). The first start downloads the modeller (~32 MB). Ctrl-C stops it.`);
      await new Promise((res) => { h.child.on('exit', res); process.on('SIGINT', () => { h.child.kill(); res(); }); });
      return;
    }
    case 'mcp': return serveMcp();
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    case '--version': console.log(VERSION); return;
    default: throw new KeelError(`Unknown command "${cmd}". Run \`keel help\`.`);
  }
}

// ---------------------------------------------------------------- MCP server (stdio)

const LOCAL_TOOLS = [
  {
    name: 'pull_document',
    description: 'Save a Keel document to a local .sc file linked to it (SolidCraft opens .sc files; so can solidcraft-cli\'s MCP server, for edits checked by the real kernel). If the file is already linked and has unpushed changes, they are kept and merged onto the newer design, with any conflicts listed. Returns the path.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Document id or loose key. Omit to update an already linked file.' }, path: { type: 'string' }, force: { type: 'boolean', description: 'Overwrite local changes instead of merging.' }, prefer: { type: 'string', enum: ['mine', 'theirs'], description: 'Who wins a field both changed.' } } },
  },
  {
    name: 'push_document',
    description: 'Send a linked .sc file\'s changes to its Keel document, merged with anything changed since. on_conflict "mine" (default) or "theirs" picks the winner of a field both changed; "ask" sends nothing when they clash, rewrites the file onto the newest design with your changes merged in, and lists the conflicts so you can fix them and push again.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, on_conflict: { type: 'string', enum: ['mine', 'theirs', 'ask'] } }, required: ['path'] },
  },
  {
    name: 'file_status',
    description: 'Whether a linked .sc file and its Keel document have changed since the last pull or push.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'upload_file',
    description: 'Make a Keel document from a local .sc file and link the file to it, so pushes and pulls keep them in step. loose: true (or no account token) makes a loose document: no account, reached by the key saved next to the file, DELETED some days after it is made (the result says when).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, loose: { type: 'boolean' }, by: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'start_host',
    description: 'Open a document in headless Chrome on this computer as an agent tab, so inspect_model, screenshot, list_commands and run_commands work without anyone having it open. It keeps running in the background; the first start takes up to a minute (the modeller downloads and starts).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Document id, key, or a linked .sc file.' } }, required: ['id'] },
  },
  {
    name: 'merge_files',
    description: 'Three-way merge of local design files, no server needed: base (the common ancestor), mine and theirs. Writes the result to out (or returns it) and lists each conflict with its base, mine and theirs values; prefer picks the winner of a field both changed.',
    inputSchema: { type: 'object', properties: { base: { type: 'string' }, mine: { type: 'string' }, theirs: { type: 'string' }, out: { type: 'string' }, prefer: { type: 'string', enum: ['mine', 'theirs'] } }, required: ['base', 'mine', 'theirs'] },
  },
];

function serveMcp() {
  const cfg = loadConfig();
  const ctx = {
    site: cfg.url,
    signedIn: !!cfg.token,
    reads: new Map(),
    call: (path, opts = {}) => call(path, opts),
    async asset(path) {
      const res = await fetch(cfg.url + path).catch((e) => { throw new KeelError(`Can't reach ${cfg.url}: ${e.message}`); });
      if (!res.ok) throw new KeelError(`${path}: HTTP ${res.status}`);
      return res.json();
    },
  };
  const run = async (name, a) => {
    switch (name) {
      case 'pull_document': return pull(a.id, a.path, { force: !!a.force, prefer: a.prefer });
      case 'push_document': return push(a.path, { onConflict: a.on_conflict || 'mine' });
      case 'file_status': return status(a.path);
      case 'upload_file': return create(a.name || basename(a.path).replace(/\.sc$/, ''), { from: a.path, loose: !!a.loose, by: a.by });
      case 'start_host': {
        const h = await host(a.id, { detached: true });
        return { hosting: h.url, pid: h.pid, note: 'Give it up to a minute to load, then use inspect_model, screenshot or run_commands. Stop it by killing the pid.' };
      }
      case 'merge_files': {
        const [b, m, t] = [a.base, a.mine, a.theirs].map((p) => readFileSync(p, 'utf8'));
        const r = mergeDesigns(b, m, t, { prefer: a.prefer === 'theirs' ? 'theirs' : 'mine' });
        if (a.out) writeAtomic(resolve(a.out), r.text);
        return { conflicts: r.details, ...(a.out ? { written: resolve(a.out) } : { design: r.text }) };
      }
      default: return runTool(ctx, name, a);
    }
  };
  const opts = {
    ctx, run,
    tools: [...TOOLS, ...LOCAL_TOOLS],
    info: { name: 'keel', version: VERSION },
    instructions:
      `Keel is collaborative CAD; these tools reach Keel documents at ${cfg.url} (people may be editing them live) and local SolidCraft .sc files. ` +
      (cfg.token ? 'Signed in with an account token. ' : 'Not signed in: create_document and upload_file make loose documents (no account, reached by key, deleted after a set number of days). ') +
      'To edit as a file: pull_document, edit the .sc file (by hand, or with solidcraft-cli\'s MCP server for kernel-checked edits), then push_document. ' + MODELLING_GUIDE + ' ' + DESIGN_NOTE,
  };
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const reply = await handleRpc(msg, opts);
    if (reply) send(reply);
  });
}

// ---------------------------------------------------------------- main

const self = resolve(new URL(import.meta.url).pathname);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(`keel: ${e.message}`);
    process.exit(e instanceof KeelError || e.status ? 1 : 2);
  });
}
