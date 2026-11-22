// One Durable Object per document: the authoritative copy of the design and the live session.
//
// The room keeps the design text and a sequence number. A client sends {type:'update', base, text}:
// if `base` is the room's sequence the update is accepted, the sequence goes up, the sender gets
// an ack and everyone else the new text. If someone got there first the sender gets the newer
// text back ({type:'stale'}), merges its change onto it in the browser (public/js/merge.js) and
// sends again. WebSockets use the hibernation API, so an idle room costs nothing.

import { mergeDesigns } from '../public/js/merge.js';
import { applyEdits, autoName, diffDesigns, reviewDesign } from '../public/js/design-edit.js';

const CHUNK = 1_000_000; // storage values are capped at 2 MB; designs can be bigger
const MAX_TEXT = 16 * 1024 * 1024; // the most SolidCraft's document.import accepts
const AUTO_VERSION_EVERY = 100; // updates between automatic versions
const AGENT_SHOWN_MS = 120_000; // an agent working over HTTP shows among the people here this long after its last call
const AGENT_SESSION_MS = 10 * 60_000; // an agent's first write after this long idle saves a version first
const HISTORY = 50; // recent designs kept (when under CHUNK), so an HTTP update naming only its base can merge
const COLORS = ['#e4572e', '#2e86ab', '#7d3c98', '#17a398', '#f2a541', '#d6336c', '#3b8c3b', '#4f5d75'];

export class DocRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.head = null; // {seq, text, by, at}
    this.agents = new Map(); // name -> {id, at, activity}: agents working over HTTP (MCP, CLI)
    this.runs = new Map(); // rid -> resolve: agent calls waiting for a host tab's reply
  }

  // An agent (a token or key, not a browser) touched the document: show it, and before its first
  // write in a while, save a version so its whole session can be undone in one restore.
  async agentSeen(user, activity, writing) {
    if (!user?.agent) return;
    const now = Date.now();
    if (writing) {
      const key = `agentWrote:${user.name}`;
      const last = (await this.ctx.storage.get(key)) || 0;
      if (now - last > AGENT_SESSION_MS && (await this.load()).seq > 0) {
        await this.snapshot(`Before ${user.name}'s changes`, user.id, true).catch(() => {});
      }
      await this.ctx.storage.put(key, now);
    }
    const was = this.agents.get(user.name);
    this.agents.set(user.name, { id: user.id, at: now, activity });
    if (!was || was.activity !== activity) this.broadcast({ type: 'peers', peers: this.peers() });
  }

  async load() {
    if (this.head) return this.head;
    const meta = (await this.ctx.storage.get('meta')) || null;
    if (!meta) {
      this.head = { seq: 0, text: '', by: null, at: 0, docId: null };
      return this.head;
    }
    const parts = await this.ctx.storage.get([...Array(meta.chunks).keys()].map((i) => `text:${i}`));
    let text = '';
    for (let i = 0; i < meta.chunks; i++) text += parts.get(`text:${i}`) || '';
    this.head = { seq: meta.seq, text, by: meta.by, at: meta.at, docId: meta.docId };
    return this.head;
  }

  async store(text, by, docId) {
    const head = await this.load();
    const chunks = Math.max(1, Math.ceil(text.length / CHUNK));
    const entries = { meta: { seq: head.seq + 1, chunks, by: by?.name || null, at: Date.now(), docId: docId || head.docId } };
    for (let i = 0; i < chunks; i++) entries[`text:${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
    if (text.length <= CHUNK) entries[`hist:${head.seq + 1}`] = text;
    await this.ctx.storage.put(entries);
    if (head.seq + 1 > HISTORY) await this.ctx.storage.delete(`hist:${head.seq + 1 - HISTORY}`);
    this.head = { seq: head.seq + 1, text, by: by?.name || null, at: entries.meta.at, docId: entries.meta.docId };
    // Tell D1 (the document list) a little later, once a burst of edits has settled.
    await this.ctx.storage.setAlarm(Date.now() + 2000);
    if (this.head.seq % AUTO_VERSION_EVERY === 0 && by) await this.snapshot(`Auto-save ${this.head.seq}`, by.id, true);
    return this.head;
  }

  async snapshot(name, userId, auto = false) {
    const head = await this.load();
    if (!head.docId) throw new Error('room has no document');
    const id = crypto.randomUUID();
    await this.env.FILES.put(`versions/${head.docId}/${id}.json`, head.text, { httpMetadata: { contentType: 'application/json' } });
    await this.env.DB.prepare('INSERT INTO versions (id, document_id, name, seq, created_by, created_at, auto) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, head.docId, name, head.seq, userId, Date.now(), auto ? 1 : 0)
      .run();
    return { id, name, seq: head.seq };
  }

  async alarm() {
    const head = await this.load();
    if (!head.docId) return;
    await this.env.DB.prepare('UPDATE documents SET updated_at = ?, updated_by = ?, seq = ? WHERE id = ?').bind(head.at, head.by, head.seq, head.docId).run();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const docId = request.headers.get('x-doc-id');
    if (url.pathname === '/ws') return this.connect(request, docId);
    const user = request.headers.get('x-user') ? JSON.parse(request.headers.get('x-user')) : null;
    if (url.pathname === '/state') {
      const head = await this.load();
      return Response.json({ seq: head.seq, text: head.text, by: head.by, at: head.at });
    }
    if (url.pathname === '/replace' && request.method === 'POST') {
      // A new document's first content, an import over it, or a restored version.
      const { text } = await request.json();
      if (typeof text !== 'string' || text.length > MAX_TEXT) return new Response('bad text', { status: 400 });
      const head = await this.store(text, user, docId);
      this.broadcast({ type: 'remote', seq: head.seq, text, by: user?.name || null, restored: true });
      return Response.json({ seq: head.seq });
    }
    if (url.pathname === '/update' && request.method === 'POST') {
      // An edit over HTTP (an agent, a script, the keel CLI or the MCP endpoint). Same rule as a
      // socket update, but when someone got in first it merges here, with the design the caller
      // started from (sent as base_text, or found in recent history). Merging is data only: the
      // server never models. on_conflict: 'mine' (default) or 'theirs' picks the winner of a field
      // both changed; 'ask' saves nothing and returns the conflicts and current design instead.
      if (request.headers.get('x-role') !== 'edit') return Response.json({ error: 'You can view this document but not edit it.' }, { status: 403 });
      const { base, text, base_text, on_conflict = 'mine' } = await request.json();
      if (typeof text !== 'string' || text.length > MAX_TEXT) return Response.json({ error: 'Design too large.' }, { status: 413 });
      const head = await this.load();
      const current = { seq: head.seq, text: head.text, by: head.by };
      let out = text, merged = null;
      if (base !== head.seq) {
        if (!Number.isInteger(base) || base > head.seq) return Response.json({ error: `There is no version ${base}; the document is at ${head.seq}.`, current }, { status: 409 });
        const from = typeof base_text === 'string' ? base_text : await this.ctx.storage.get(`hist:${base}`);
        if (typeof from !== 'string') return Response.json({ error: `Someone else changed the design since version ${base}, which is too old to merge from. Read it again and redo the change.`, current }, { status: 409 });
        try { merged = mergeDesigns(from, text, head.text, { prefer: on_conflict === 'theirs' ? 'theirs' : 'mine' }); } catch (e) {
          return Response.json({ error: `Couldn't merge with the newer design: ${e.message}`, current }, { status: 409 });
        }
        if (on_conflict === 'ask' && merged.details.length) {
          return Response.json({
            error: `Not saved: ${merged.details.length} conflict(s) with changes made since version ${base}. Resolve them in the design, then write again with base ${head.seq}.`,
            conflicts: merged.details, current, merged_text: merged.text,
          }, { status: 409 });
        }
        out = merged.text;
      }
      // Agents' new features get names from what they do, unless the agent named them.
      let named = 0;
      if (user?.agent) {
        try { const d = JSON.parse(out); named = autoName(d); if (named) out = JSON.stringify(d, null, 2); } catch { /* left as sent */ }
      }
      const result = { merged: !!merged, conflicts: merged?.details || [], ...(merged || named ? { text: out, auto_named: named } : {}) };
      const same = (x, y) => { try { return JSON.stringify(JSON.parse(x)) === JSON.stringify(JSON.parse(y)); } catch { return x === y; } };
      if (same(out, head.text)) return Response.json({ seq: head.seq, unchanged: true, ...result });
      if (merged) result.merged_with = head.by;
      await this.agentSeen(user, 'editing', true);
      const next = await this.store(out, user, docId);
      this.broadcast({ type: 'remote', seq: next.seq, text: out, by: user?.name || null });
      return Response.json({ seq: next.seq, ...result });
    }
    if (url.pathname === '/edit' && request.method === 'POST') {
      // Typed edits (design-edit.js), applied to the current design, so they can't conflict.
      if (request.headers.get('x-role') !== 'edit') return Response.json({ error: 'You can view this document but not edit it.' }, { status: 403 });
      const { edits } = await request.json();
      const head = await this.load();
      let r;
      try { r = applyEdits(head.text, edits); } catch (e) { return Response.json({ error: e.message, seq: head.seq }, { status: 400 }); }
      if (user?.agent) {
        const d = JSON.parse(r.text);
        const n = autoName(d);
        if (n) { r.text = JSON.stringify(d, null, 2); r.done.push(`${n} feature${n > 1 ? 's' : ''} named`); }
      }
      if (r.text.length > MAX_TEXT) return Response.json({ error: 'Design too large.' }, { status: 413 });
      if (r.text === head.text) return Response.json({ seq: head.seq, unchanged: true, done: r.done });
      await this.agentSeen(user, 'editing', true);
      const next = await this.store(r.text, user, docId);
      this.broadcast({ type: 'remote', seq: next.seq, text: r.text, by: user?.name || null });
      return Response.json({ seq: next.seq, done: r.done, before_seq: head.seq });
    }
    if (url.pathname === '/review') {
      const head = await this.load();
      try { return Response.json({ seq: head.seq, ...reviewDesign(head.text) }); } catch (e) { return Response.json({ error: `Can't read the design: ${e.message}` }, { status: 422 }); }
    }
    if (url.pathname === '/changes') {
      // What changed since a recent seq, readably (design-edit.js diffDesigns).
      const since = Number(url.searchParams.get('since'));
      const head = await this.load();
      if (!Number.isInteger(since) || since < 0 || since > head.seq) return Response.json({ error: `since must be a seq from 0 to ${head.seq}.` }, { status: 400 });
      if (since === head.seq) return Response.json({ since, seq: head.seq, summary: 'no changes' });
      const from = since === 0 ? JSON.stringify({ features: [], params: [] }) : await this.ctx.storage.get(`hist:${since}`);
      if (typeof from !== 'string') return Response.json({ error: `Version ${since} is too old to compare (the last ${HISTORY} changes are kept). Read the document instead.`, seq: head.seq }, { status: 410 });
      return Response.json({ since, seq: head.seq, by: head.by, ...diffDesigns(from, head.text) });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      // Agent calls run by a browser tab that has the document open with agents allowed (a host):
      // SolidCraft's own commands and inspections, and viewport screenshots. The server relays;
      // the modelling happens in that tab, and any change syncs like the person's own edit.
      const { calls, at_seq, timeout_ms } = await request.json();
      const bad = checkCalls(calls);
      if (bad) return Response.json({ error: bad }, { status: 400 });
      const now = (await this.load()).seq;
      if (Number.isInteger(at_seq) && at_seq > now) return Response.json({ error: `There is no version ${at_seq} yet; the document is at ${now}.` }, { status: 400 });
      const writes = calls.some((c) => WRITE_METHODS.has(c.method));
      if (writes && request.headers.get('x-role') !== 'edit') return Response.json({ error: 'You can view this document but not edit it.' }, { status: 403 });
      const hosts = this.ctx.getWebSockets().filter((ws) => {
        const a = ws.deserializeAttachment();
        return a.host && (!writes || a.role === 'edit');
      });
      if (!hosts.length) {
        return Response.json({
          error: 'No browser tab is open on this document with agents allowed, so nothing can run the modeller. ' +
            'Open the document in a browser (its Agents switch is on by default), or run `keel host <id or key>` to open a headless one.',
          hosts: 0,
        }, { status: 503 });
      }
      const pick = hosts.find((ws) => ws.deserializeAttachment().dedicated) || hosts[0];
      const rid = crypto.randomUUID();
      const wait = Math.min(Math.max(Number(timeout_ms) || 60_000, 5_000), 300_000);
      await this.agentSeen(user, writes ? 'modelling' : 'looking', writes);
      const answer = new Promise((resolve) => {
        this.runs.set(rid, resolve);
        setTimeout(() => resolve({ ok: false, timeout: true, error: `The browser tab didn't answer within ${wait / 1000} s. A hidden or sleeping tab runs slowly: keep it visible, or use \`keel host\`.` }), wait);
      });
      pick.send(JSON.stringify({ type: 'run', rid, calls, at_seq: Number.isInteger(at_seq) ? at_seq : null, timeout_ms: wait, by: user?.name || 'An agent' }));
      const out = await answer;
      this.runs.delete(rid);
      return Response.json({ ...out, host: pick.deserializeAttachment().user.name }, { status: out.timeout ? 504 : 200 });
    }
    if (url.pathname === '/renamed' && request.method === 'POST') {
      const { name } = await request.json();
      this.broadcast({ type: 'renamed', name, by: user?.name || null });
      return Response.json({ ok: true });
    }
    if (url.pathname === '/seen' && request.method === 'POST') {
      await this.agentSeen(user, (await request.json().catch(() => ({}))).activity || 'reading', false);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/snapshot' && request.method === 'POST') {
      const { name } = await request.json();
      return Response.json(await this.snapshot(String(name || 'Version').slice(0, 120), user.id));
    }
    if (url.pathname === '/close' && request.method === 'POST') {
      // The document was deleted or someone's access was removed: drop their sockets.
      const { userId } = await request.json().catch(() => ({}));
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (!userId || a.user.id === userId) ws.close(4403, 'access removed');
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/purge' && request.method === 'POST') {
      // A loose document reached its deletion date: drop everyone and erase the room.
      for (const ws of this.ctx.getWebSockets()) ws.close(4410, 'document deleted');
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.head = null;
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  async connect(request, docId) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const user = JSON.parse(request.headers.get('x-user'));
    const role = request.headers.get('x-role');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const conn = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    const color = colorFor(user.id);
    server.serializeAttachment({ user: { id: user.id, name: user.name }, role, conn, color, activity: null });
    const head = await this.load();
    if (!head.docId && docId) head.docId = docId;
    server.send(JSON.stringify({ type: 'welcome', you: { conn, color, role, id: user.id, name: user.name }, seq: head.seq, text: head.text, peers: this.peers() }));
    this.broadcast({ type: 'peers', peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  peers() {
    const now = Date.now();
    const people = this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment();
      return { conn: a.conn, id: a.user.id, name: a.user.name, color: a.color, role: a.role, activity: a.activity, host: !!a.host };
    });
    for (const [name, g] of this.agents) {
      if (now - g.at > AGENT_SHOWN_MS) { this.agents.delete(name); continue; }
      people.push({ conn: `agent:${name}`, id: g.id, name, color: colorFor(`agent:${name}`), role: 'edit', activity: g.activity, agent: true });
    }
    return people;
  }

  broadcast(message, except = null) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch { /* closing */ }
    }
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
    const a = ws.deserializeAttachment();
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    if (msg.type === 'presence') {
      a.activity = typeof msg.activity === 'string' ? msg.activity.slice(0, 120) : null;
      ws.serializeAttachment(a);
      return this.broadcast({ type: 'peers', peers: this.peers() });
    }
    if (msg.type === 'host') {
      a.host = !!msg.on;
      a.dedicated = !!msg.dedicated;
      ws.serializeAttachment(a);
      return this.broadcast({ type: 'peers', peers: this.peers() });
    }
    if (msg.type === 'ran') {
      const resolve = this.runs.get(msg.rid);
      if (resolve) { this.runs.delete(msg.rid); const { type, rid, ...rest } = msg; resolve(rest); }
      return;
    }
    if (msg.type === 'update') {
      if (a.role !== 'edit') return ws.send(JSON.stringify({ type: 'error', id: msg.id, message: 'You can view this document but not edit it.' }));
      if (typeof msg.text !== 'string' || msg.text.length > MAX_TEXT) return ws.send(JSON.stringify({ type: 'error', id: msg.id, message: 'Design too large.' }));
      const head = await this.load();
      if (msg.base !== head.seq) {
        return ws.send(JSON.stringify({ type: 'stale', id: msg.id, seq: head.seq, text: head.text, by: head.by }));
      }
      const next = await this.store(msg.text, a.user, null);
      ws.send(JSON.stringify({ type: 'ack', id: msg.id, seq: next.seq }));
      this.broadcast({ type: 'remote', seq: next.seq, text: msg.text, by: a.user.name }, ws);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
    this.broadcast({ type: 'peers', peers: this.peers().filter((p) => p.conn !== ws.deserializeAttachment().conn) });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}

// What agents may ask a host tab to run. Reads change nothing in the design; writes run engine
// commands (which sync as edits). Commands that touch files, plugins or the app are refused.
const READ_METHODS = new Set(['document.inspect', 'ui.inspect', 'engine.commands', 'keel.screenshot', 'ui.view', 'ui.camera']);
const WRITE_METHODS = new Set(['engine.execute', 'engine.batch']);
const BLOCKED_COMMAND = /^(file|doc|app|plugin|script|window|help|prefs|edit\.preferences)\.|\.(open|save|save_as|export|import|insert_step|insert_mesh)$/;

function checkCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return 'Give calls: [{method, params}].';
  if (calls.length > 50) return 'At most 50 calls at once.';
  for (const c of calls) {
    if (!c || typeof c.method !== 'string') return 'Each call needs a method.';
    if (!READ_METHODS.has(c.method) && !WRITE_METHODS.has(c.method)) return `"${c.method}" isn't available to agents. Methods: ${[...READ_METHODS, ...WRITE_METHODS].join(', ')}.`;
    if (c.method === 'engine.batch' && (c.params?.commands || []).length > 500) return 'At most 500 commands in one batch; split it.';
    const cmds = c.method === 'engine.execute' ? [c.params?.command ?? c.params?.id] : c.method === 'engine.batch' ? (c.params?.commands || []).map((x) => x?.command ?? x?.id) : [];
    for (const id of cmds) {
      if (typeof id !== 'string') return `${c.method} needs a command id.`;
      if (BLOCKED_COMMAND.test(id)) return `The command "${id}" isn't available to agents (files, plugins and app settings stay with the person).`;
    }
  }
  return null;
}

function colorFor(key) {
  return COLORS[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
}
