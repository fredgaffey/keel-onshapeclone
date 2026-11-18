// Keel's Worker: the account and document API, the live-editing rooms, and the static site
// (Keel's pages in public/, SolidCraft's browser build in public/cad/ with its WebAssembly in R2).

import { HttpError, checkPassword, createUser, currentUser, endSession, randomId, startSession, validEmail } from './auth.js';

export { DocRoom } from './room.js';

const MAX_BODY = 17 * 1024 * 1024;
const EMPTY_DESIGN = (name) =>
  JSON.stringify({ format: 'solidcraft/57', name, units: 'mm', params: [], features: [], next_id: 1, next_component_color_index: 0 }, null, 2);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname.startsWith('/cad/') && url.pathname.endsWith('_bg.wasm')) return await wasm(env, url);
      if (/^\/d\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/doc', url), request));
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

// SolidCraft's WebAssembly is ~166 MB, over the 25 MiB limit for static assets, so a Brotli copy
// lives in R2 and goes out as-is; the browser decompresses it.
async function wasm(env, url) {
  const obj = await env.FILES.get(`cad/${url.pathname.split('/').pop()}`);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/wasm',
      'content-encoding': 'br',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
    encodeBody: 'manual',
  });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

async function body(request) {
  const type = request.headers.get('content-type') || '';
  // JSON only: a cross-site form can't send it without a CORS preflight, which we never grant.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Too large.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

async function api(request, env, url) {
  const method = request.method;
  const path = url.pathname.slice('/api'.length);
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) throw new HttpError(403, 'Cross-site request refused.');
  const secure = url.protocol === 'https:';

  if (path === '/signup' && method === 'POST') {
    if (env.SIGNUP === 'closed') throw new HttpError(403, 'Sign-up is closed on this server.');
    const user = await createUser(env, await body(request));
    return json({ user }, 201, { 'set-cookie': await startSession(env, user.id, secure) });
  }
  if (path === '/login' && method === 'POST') {
    const { email, password } = await body(request);
    const user = await checkPassword(env, email, password);
    return json({ user }, 200, { 'set-cookie': await startSession(env, user.id, secure) });
  }
  if (path === '/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': await endSession(env, request) });
  }
  if (path === '/config' && method === 'GET') {
    return json({ signup: env.SIGNUP !== 'closed', dev: devMode(env, url) });
  }

  if (path === '/dev/as' && method === 'GET') {
    // Dev mode: become any user by name, e.g. /api/dev/as?name=Bob (made on first use).
    if (!devMode(env, url)) throw new HttpError(404, 'Not found.');
    const user = await devUser(env, url.searchParams.get('name') || 'Dev');
    return new Response(null, { status: 302, headers: { location: url.searchParams.get('next') || '/', 'set-cookie': await startSession(env, user.id, secure) } });
  }

  let user = await currentUser(env, request);
  if (!user && devMode(env, url)) user = await devUser(env, 'Dev');
  if (!user) throw new HttpError(401, 'Sign in first.');

  if (path === '/me' && method === 'GET') return json({ user });

  if (path === '/docs' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.name, d.created_at, d.updated_at, d.updated_by, d.seq, o.name AS owner_name, o.email AS owner_email,
              CASE WHEN d.owner_id = ?1 THEN 'owner' ELSE s.role END AS role
         FROM documents d
         JOIN users o ON o.id = d.owner_id
         LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?1
        WHERE d.deleted_at IS NULL AND (d.owner_id = ?1 OR s.user_id IS NOT NULL)
        ORDER BY d.updated_at DESC LIMIT 500`,
    ).bind(user.id).all();
    return json({ documents: results });
  }
  if (path === '/docs' && method === 'POST') {
    const b = await body(request);
    const name = cleanName(b.name) || 'Untitled document';
    let text = typeof b.text === 'string' && b.text.trim() ? b.text : EMPTY_DESIGN(name);
    checkDesign(text);
    const id = randomId(10);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO documents (id, owner_id, name, created_at, updated_at, updated_by, seq) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .bind(id, user.id, name, now, now, user.name)
      .run();
    await room(env, id, user, 'owner').fetch('https://room/replace', { method: 'POST', body: JSON.stringify({ text }) });
    return json({ document: { id, name, role: 'owner' } }, 201);
  }

  const m = /^\/docs\/([A-Za-z0-9]+)(\/.*)?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found.');
  const [, docId, sub = ''] = m;
  const doc = await env.DB.prepare(
    `SELECT d.*, CASE WHEN d.owner_id = ?2 THEN 'owner' ELSE s.role END AS role
       FROM documents d LEFT JOIN shares s ON s.document_id = d.id AND s.user_id = ?2
      WHERE d.id = ?1 AND d.deleted_at IS NULL`,
  ).bind(docId, user.id).first();
  if (!doc || !doc.role) throw new HttpError(404, 'No such document, or it isn\'t shared with you.');
  const canEdit = doc.role === 'owner' || doc.role === 'edit';
  const needEdit = () => { if (!canEdit) throw new HttpError(403, 'You can view this document but not edit it.'); };
  const needOwner = () => { if (doc.role !== 'owner') throw new HttpError(403, 'Only the owner can do that.'); };
  const stub = room(env, docId, user, doc.role);

  if (sub === '' && method === 'GET') {
    return json({ document: { id: doc.id, name: doc.name, role: doc.role, seq: doc.seq, updated_at: doc.updated_at, updated_by: doc.updated_by } });
  }
  if (sub === '' && method === 'PATCH') {
    needEdit();
    const name = cleanName((await body(request)).name);
    if (!name) throw new HttpError(400, 'Give it a name.');
    await env.DB.prepare('UPDATE documents SET name = ? WHERE id = ?').bind(name, docId).run();
    return json({ ok: true, name });
  }
  if (sub === '' && method === 'DELETE') {
    needOwner();
    await env.DB.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').bind(Date.now(), docId).run();
    await stub.fetch('https://room/close', { method: 'POST', body: '{}' });
    return json({ ok: true });
  }
  if (sub === '/ws') {
    if (request.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket.');
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Cross-site WebSocket refused.');
    return stub.fetch('https://room/ws', request);
  }
  if (sub === '/content' && method === 'GET') {
    return stub.fetch('https://room/state');
  }
  if (sub === '/content' && method === 'PUT') {
    needEdit();
    const { text } = await body(request);
    checkDesign(text);
    return stub.fetch('https://room/replace', { method: 'POST', body: JSON.stringify({ text }) });
  }
  if (sub === '/shares' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT u.id, u.email, u.name, s.role FROM shares s JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.email',
    ).bind(docId).all();
    const owner = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(doc.owner_id).first();
    return json({ owner, shares: results });
  }
  if (sub === '/shares' && method === 'POST') {
    needOwner();
    const { email, role } = await body(request);
    if (!validEmail(String(email || '').trim())) throw new HttpError(400, 'Enter an email address.');
    if (role !== 'edit' && role !== 'view') throw new HttpError(400, 'Role must be edit or view.');
    const target = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(String(email).trim().toLowerCase()).first();
    if (!target) throw new HttpError(404, 'Nobody has a Keel account with that email yet. Ask them to sign up first.');
    if (target.id === doc.owner_id) throw new HttpError(400, 'That\'s the owner.');
    await env.DB.prepare(
      'INSERT INTO shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role',
    ).bind(docId, target.id, role, Date.now()).run();
    // Their open sessions still carry the old role: close them so they reconnect with the new one.
    await stub.fetch('https://room/close', { method: 'POST', body: JSON.stringify({ userId: target.id }) });
    return json({ share: { ...target, role } });
  }
  const unshare = /^\/shares\/([A-Za-z0-9]+)$/.exec(sub);
  if (unshare && method === 'DELETE') {
    needOwner();
    await env.DB.prepare('DELETE FROM shares WHERE document_id = ? AND user_id = ?').bind(docId, unshare[1]).run();
    await stub.fetch('https://room/close', { method: 'POST', body: JSON.stringify({ userId: unshare[1] }) });
    return json({ ok: true });
  }
  if (sub === '/versions' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT v.id, v.name, v.seq, v.created_at, v.auto, u.name AS created_by
         FROM versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.document_id = ? ORDER BY v.created_at DESC LIMIT 200`,
    ).bind(docId).all();
    return json({ versions: results });
  }
  if (sub === '/versions' && method === 'POST') {
    needEdit();
    const { name } = await body(request);
    return stub.fetch('https://room/snapshot', { method: 'POST', body: JSON.stringify({ name: cleanName(name) || 'Version' }) });
  }
  const ver = /^\/versions\/([0-9a-f-]{36})(\/restore)?$/.exec(sub);
  if (ver) {
    const row = await env.DB.prepare('SELECT id, name FROM versions WHERE id = ? AND document_id = ?').bind(ver[1], docId).first();
    if (!row) throw new HttpError(404, 'No such version.');
    const obj = await env.FILES.get(`versions/${docId}/${row.id}.json`);
    if (!obj) throw new HttpError(404, 'That version\'s file is missing.');
    const text = await obj.text();
    if (!ver[2] && method === 'GET') return json({ name: row.name, text });
    if (ver[2] && method === 'POST') {
      needEdit();
      return stub.fetch('https://room/replace', { method: 'POST', body: JSON.stringify({ text }) });
    }
  }
  throw new HttpError(404, 'Not found.');
}

function room(env, docId, user, role) {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(docId));
  const headers = { 'x-doc-id': docId, 'x-user': JSON.stringify({ id: user.id, name: user.name }), 'x-role': role === 'owner' ? 'edit' : role };
  return {
    fetch(target, init) {
      const req = init instanceof Request ? new Request(target, init) : new Request(target, init);
      for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
      return stub.fetch(req);
    },
  };
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
}

function checkDesign(text) {
  if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) throw new HttpError(400, 'A design must be JSON text under 16 MiB.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'That isn\'t a SolidCraft design (not JSON).'); }
  if (!parsed || typeof parsed.format !== 'string' || !Array.isArray(parsed.features)) throw new HttpError(400, 'That isn\'t a SolidCraft design.');
}

// Dev mode skips sign-in: with DEV_AUTH=1 (in .dev.vars, never in wrangler.jsonc) every request
// without a session is the user "Dev". It only ever applies on localhost, so a deployment with the
// variable set by mistake still asks everyone to sign in.
function devMode(env, url) {
  return env.DEV_AUTH === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

async function devUser(env, name) {
  name = cleanName(name).slice(0, 40) || 'Dev';
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'dev'}@dev.localhost`;
  const row = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(email).first();
  if (row) return row;
  const id = randomId();
  await env.DB.prepare('INSERT INTO users (id, email, name, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, name, '', '!', Date.now()) // '!' matches no PBKDF2 hash: no password sign-in
    .run();
  return { id, email, name };
}
