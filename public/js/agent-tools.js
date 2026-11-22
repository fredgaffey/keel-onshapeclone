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

export const DESIGN_NOTE =
  'A design is SolidCraft JSON: {format, name, units, params:[{name, value...}], features:[{id, name, type, suppressed, ...}], next_id, ...}. ' +
  'Keep the format string as it is. New features take ids from next_id (then raise next_id), and each gets a short descriptive name ' +
  '("Mounting holes", not "Extrude 3"). Copy the shape of an existing feature of the same type when adding one.';

const ID = {
  type: 'string',
  description: 'The document id, or a loose document\'s key (keel_...). A key works without signing in.',
};

export const TOOLS = [
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
      `Loose documents lapse after 90 days unused. ${DESIGN_NOTE}`,
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
      'set {feature, path ("depth" or "extent.distance"), value}, add {feature: {type, name?, ...fields}, after?} (id and a unique name are filled in), move {feature, after}, rename_design {name}. ' +
      'check: true then rebuilds it in a browser tab with the real kernel and reports errors (needs a tab open on the document; see inspect_model).',
    inputSchema: {
      type: 'object',
      properties: { id: ID, edits: { type: 'array', items: { type: 'object' } }, check: { type: 'boolean' } },
      required: ['id', 'edits'],
    },
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
      'Runs in a browser tab that has the document open with agents allowed (on by default), or one started with `keel host`. Pass at_seq (from a write) to inspect that version.',
    inputSchema: { type: 'object', properties: { id: ID, measure: { type: 'boolean' }, at_seq: { type: 'integer' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'screenshot',
    description: 'A picture of the model as rendered by the modeller, from a browser tab on the document (see inspect_model). view: iso, front, back, top, bottom, left, right, home or fit.',
    inputSchema: { type: 'object', properties: { id: ID, view: { type: 'string', enum: ['iso', 'front', 'back', 'top', 'bottom', 'left', 'right', 'home', 'fit'] }, at_seq: { type: 'integer' } }, required: ['id'] },
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
      'Name what you make: most create commands take a name or body_name ("Mounting plate", not "Extrude1"). screenshot: a view name to get a picture afterwards.',
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

export function openUrl(ctx, id, key) {
  return `${ctx.site}/d/${id}${key ? `#key=${key}` : ''}`;
}

function checkDesign(text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error(`The design isn't valid JSON: ${e.message}`); }
  if (!d || typeof d.format !== 'string' || !Array.isArray(d.features)) throw new Error('That isn\'t a SolidCraft design: it needs a "format" string and a "features" list.');
}

export async function runTool(ctx, name, a = {}) {
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
        ...(r.merged ? { note: 'Others changed the design meanwhile; their changes were merged in. read_document shows the result.' } : {}),
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
      const r = await run(ctx, t, [{ method: 'keel.screenshot', params: { view: a.view } }], a.at_seq);
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
        return { format: cat.format, note: DESIGN_NOTE, examples: Object.keys(cat.examples), command_families: families, next: 'describe_format with a topic shows examples; list_commands searches commands.' };
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
      const text = { ok: r.ok && !batch?.failed, seq: r.seq, saved: r.saved, completed: batch?.completed, failed: batch?.failed || r.failed || undefined, results: batch?.results };
      const shot = r.results[1];
      if (shot?.image) return { __content: [{ type: 'text', text: JSON.stringify(text, null, 2) }, { type: 'image', data: shot.image, mimeType: shot.mime }] };
      return text;
    }
    case 'save_version': {
      const t = await target(ctx, a.id);
      return ctx.call(`/docs/${t.id}/versions`, { method: 'POST', body: { name: a.name }, key: t.key });
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

async function inspect(ctx, t, { measure = false, at_seq = null } = {}) {
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
    params: d.params,
    units: d.units,
  };
}

// One MCP JSON-RPC message in, one reply out (null for notifications).
export async function handleRpc(msg, { ctx, tools = TOOLS, run = (n, a) => runTool(ctx, n, a), info, instructions }) {
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
