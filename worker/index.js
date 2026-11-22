// Keel's Worker: the account and document API, the live-editing rooms, and the static site
// (Keel's pages in public/, SolidCraft's browser build in public/cad/ with its WebAssembly in R2).

import { HttpError, checkPassword, createGuest, createToken, createUser, currentUser, endSession, listTokens, looseDays, randomId, revokeToken, startSession, validEmail } from './auth.js';
import { mcp } from './mcp.js';
import { isOAuthPath, oauth } from './oauth.js';

export { DocRoom } from './room.js';

const MAX_BODY = 34 * 1024 * 1024; // a design and the base it started from, 16 MiB each
const EMPTY_DESIGN = (name) =>
  JSON.stringify({ format: 'solidcraft/57', name, units: 'mm', params: [], features: [], next_id: 1, next_component_color_index: 0 }, null, 2);

export default {
  fetch: (request, env) => handle(request, env),
  // Hourly: delete loose documents past their deletion date.
  scheduled: (event, env, ctx) => ctx.waitUntil(purgeLoose(env)),
};

async function handle(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname === '/mcp' || url.pathname === '/mcp/loose') return await mcp(request, env, url, (req) => handle(req, env), { loose: url.pathname === '/mcp/loose' });
      if (isOAuthPath(url.pathname)) return await oauth(request, env, url);
      if (url.pathname.startsWith('/cad/') && url.pathname.endsWith('_bg.wasm')) return await wasm(env, url);
      if (/^\/d\/[A-Za-z0-9]+\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/doc', url), request));
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
}

async function purgeLoose(env) {
  const { results } = await env.DB.prepare('SELECT id, owner_id FROM documents WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 200').bind(Date.now()).all();
  for (const d of results) {
    try {
      await env.ROOMS.get(env.ROOMS.idFromName(d.id)).fetch('https://room/purge', { method: 'POST', body: '{}' });
      for (let cursor; ;) {
        const page = await env.FILES.list({ prefix: `versions/${d.id}/`, cursor });
        if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM versions WHERE document_id = ?').bind(d.id),
        env.DB.prepare('DELETE FROM shares WHERE document_id = ?').bind(d.id),
        env.DB.prepare('DELETE FROM api_tokens WHERE document_id = ?').bind(d.id),
        env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(d.id),
        // The guest who owned it, once they own nothing else.
        env.DB.prepare("DELETE FROM users WHERE id = ? AND email LIKE 'guest-%@loose.invalid' AND NOT EXISTS (SELECT 1 FROM documents WHERE owner_id = ?)").bind(d.owner_id, d.owner_id),
      ]);
      console.log(`purged loose document ${d.id}`);
    } catch (e) {
      console.error(`purging ${d.id}:`, e);
    }
  }
  return results.length;
}

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
    return json({ signup: env.SIGNUP !== 'closed', dev: devMode(env, url), loose: env.LOOSE !== 'closed', loose_days: looseDays(env) });
  }

  if (path === '/loose' && method === 'POST') {
    // A loose document: no account. A guest user owns it, and the key returned is a token that
    // reaches only this document. It is deleted LOOSE_DAYS after it's made, whatever happens.
    if (env.LOOSE === 'closed') throw new HttpError(403, 'Loose documents are turned off on this server. Sign in with an account token.');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (env.LOOSE_LIMIT && !(await env.LOOSE_LIMIT.limit({ key: ip })).success) throw new HttpError(429, 'Too many loose documents from here just now. Try again in a minute.');
    const b = await body(request);
    const name = cleanName(b.name) || 'Untitled document';
    const text = typeof b.text === 'string' && b.text.trim() ? b.text : EMPTY_DESIGN(name);
    checkDesign(text);
    const guest = await createGuest(env, b.by);
    const id = randomId(10);
    const now = Date.now();
    const expires = now + looseDays(env) * 86400_000;
    await env.DB.prepare('INSERT INTO documents (id, owner_id, name, created_at, updated_at, updated_by, seq, expires_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .bind(id, guest.id, name, now, now, guest.name, expires)
      .run();
    const t = await createToken(env, guest.id, { name: 'document key', documentId: id, expiresAt: expires });
    await room(env, id, guest, 'owner').fetch('https://room/replace', { method: 'POST', body: JSON.stringify({ text }) });
    return json({
      document: { id, name, expires_at: expires },
      key: t.token,
      url: `${url.origin}/d/${id}#key=${t.token}`,
      deleted_at: new Date(expires).toISOString(),
      note: `Loose document: no account. It will be DELETED on ${new Date(expires).toUTCString()} (${looseDays(env)} days after it was made), with all its versions. The key is the only way in and is not shown again; anyone with it (or the url) can edit. Download it to keep a copy.`,
    }, 201);
  }

  if (path === '/dev/as' && method === 'GET') {
    // Dev mode: become any user by name, e.g. /api/dev/as?name=Bob (made on first use).
    if (!devMode(env, url)) throw new HttpError(404, 'Not found.');
    const user = await devUser(env, url.searchParams.get('name') || 'Dev');
    return new Response(null, { status: 302, headers: { location: url.searchParams.get('next') || '/', 'set-cookie': await startSession(env, user.id, secure) } });
  }

  // Browsers can't put headers on a WebSocket, so a loose document's editor sends its key in the URL.
  let user = await currentUser(env, request, path.endsWith('/ws') ? url.searchParams.get('key') : null);
  if (!user && devMode(env, url)) user = await devUser(env, 'Dev');
  if (!user) throw new HttpError(401, 'Sign in first.');
  if (user.via === 'token' && user.token.scope === 'read' && method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(403, 'This API token is read-only.');
  }

  if (path === '/me' && method === 'GET') return json({ user });

  // A document key (a loose document's, or any token limited to one document) reaches only that document.
  const only = user.token?.document_id;
  if (only && !(path === `/docs/${only}` || path.startsWith(`/docs/${only}/`))) {
    throw new HttpError(403, 'This key opens one document only.');
  }

  // API tokens are managed from a signed-in browser only, so a leaked token can't mint more.
  if (path === '/tokens' || path.startsWith('/tokens/')) {
    if (user.via === 'token') throw new HttpError(403, 'Manage API tokens from the Keel website, not with a token.');
    if (path === '/tokens' && method === 'GET') return json({ tokens: await listTokens(env, user.id) });
    if (path === '/tokens' && method === 'POST') return json({ token: await createToken(env, user.id, await body(request)) }, 201);
    const t = /^\/tokens\/([A-Za-z0-9]+)$/.exec(path);
    if (t && method === 'DELETE') { await revokeToken(env, user.id, t[1]); return json({ ok: true }); }
    throw new HttpError(404, 'Not found.');
  }

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
    return json({ document: { id: doc.id, name: doc.name, role: doc.role, seq: doc.seq, updated_at: doc.updated_at, updated_by: doc.updated_by, expires_at: doc.expires_at || null } });
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
    if (user.via === 'token') await stub.fetch('https://room/seen', { method: 'POST', body: JSON.stringify({ activity: 'reading' }) });
    return stub.fetch('https://room/state');
  }
  if (sub === '/edit' && method === 'POST') {
    // Typed edits for agents (public/js/design-edit.js), applied to the current design.
    needEdit();
    const { edits } = await body(request);
    return stub.fetch('https://room/edit', { method: 'POST', body: JSON.stringify({ edits }) });
  }
  if (sub === '/review' && method === 'GET') return stub.fetch('https://room/review');
  if (sub === '/changes' && method === 'GET') {
    return stub.fetch(`https://room/changes?since=${encodeURIComponent(url.searchParams.get('since') ?? '')}`);
  }
  if (sub === '/run' && method === 'POST') {
    // SolidCraft commands, inspections and screenshots, run by a browser tab on this document.
    const b = await body(request);
    return stub.fetch('https://room/run', { method: 'POST', body: JSON.stringify({ calls: b.calls, at_seq: b.at_seq, timeout_ms: b.timeout_ms }) });
  }
  if (sub === '/content' && method === 'PUT') {
    // With `base` (the seq the change started from) the room merges it with anything newer (see
    // DocRoom /update). Without `base` it overwrites.
    needEdit();
    const b = await body(request);
    checkDesign(b.text);
    if (b.base === undefined) return stub.fetch('https://room/replace', { method: 'POST', body: JSON.stringify({ text: b.text }) });
    if (!Number.isInteger(b.base) || b.base < 0) throw new HttpError(400, '`base` must be the seq you started from.');
    if (b.base_text !== undefined) checkDesign(b.base_text);
    if (b.on_conflict !== undefined && !['mine', 'theirs', 'ask'].includes(b.on_conflict)) throw new HttpError(400, '`on_conflict` is mine, theirs or ask.');
    return stub.fetch('https://room/update', { method: 'POST', body: JSON.stringify({ base: b.base, text: b.text, base_text: b.base_text, on_conflict: b.on_conflict }) });
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
  const headers = { 'x-doc-id': docId, 'x-user': JSON.stringify({ id: user.id, name: user.via === 'token' && !user.token.document_id ? `${user.name} (${user.token.name})` : user.name, agent: user.via === 'token' }), 'x-role': role === 'owner' ? 'edit' : role };
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
