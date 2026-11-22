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
      return {
        saved: !r.unchanged, seq: r.seq, merged: r.merged, conflicts: r.conflicts,
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
