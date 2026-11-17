// One Durable Object per document: the authoritative copy of the design and the live session.
//
// The room keeps the design text and a sequence number. A client sends {type:'update', base, text}:
// if `base` is the room's sequence the update is accepted, the sequence goes up, the sender gets
// an ack and everyone else the new text. If someone got there first the sender gets the newer
// text back ({type:'stale'}), merges its change onto it in the browser (public/js/merge.js) and
// sends again. WebSockets use the hibernation API, so an idle room costs nothing.

const CHUNK = 1_000_000; // storage values are capped at 2 MB; designs can be bigger
const MAX_TEXT = 16 * 1024 * 1024; // the most SolidCraft's document.import accepts
const AUTO_VERSION_EVERY = 100; // updates between automatic versions
const COLORS = ['#e4572e', '#2e86ab', '#7d3c98', '#17a398', '#f2a541', '#d6336c', '#3b8c3b', '#4f5d75'];

export class DocRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.head = null; // {seq, text, by, at}
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
    await this.ctx.storage.put(entries);
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
    const color = COLORS[[...user.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
    server.serializeAttachment({ user: { id: user.id, name: user.name }, role, conn, color, activity: null });
    const head = await this.load();
    if (!head.docId && docId) head.docId = docId;
    server.send(JSON.stringify({ type: 'welcome', you: { conn, color, role, id: user.id, name: user.name }, seq: head.seq, text: head.text, peers: this.peers() }));
    this.broadcast({ type: 'peers', peers: this.peers() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  peers() {
    return this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment();
      return { conn: a.conn, id: a.user.id, name: a.user.name, color: a.color, role: a.role, activity: a.activity };
    });
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
