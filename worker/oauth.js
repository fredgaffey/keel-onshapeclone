// OAuth 2.1 authorization server for MCP clients, per the MCP authorization spec: protected
// resource metadata (RFC 9728), server metadata (RFC 8414), dynamic client registration
// (RFC 7591), authorization code with PKCE S256, and rotating refresh tokens. Public clients only.
//
// A person signs in to Keel as usual, sees what is asking, and allows it. The access token is an
// ordinary API token (named after the client), so it shows under "API tokens and agents" and
// revoking it there disconnects the client.

import { HttpError, createToken, currentUser, randomId, sha256 } from './auth.js';

const CODE_MS = 10 * 60_000;
const ACCESS_DAYS = 30;
const REFRESH_DAYS = 365;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '86400',
};

const jsonCors = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...headers } });
const oauthError = (error, description, status = 400) => jsonCors({ error, error_description: description }, status);

export const resourceMetadataUrl = (url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`;
export { cors };

export function isOAuthPath(path) {
  return path.startsWith('/.well-known/oauth-') || path.startsWith('/oauth/');
}

export async function oauth(request, env, url) {
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return jsonCors({
      resource: `${url.origin}/mcp`,
      authorization_servers: [url.origin],
      bearer_methods_supported: ['header'],
      resource_name: 'Keel',
      resource_documentation: `${url.origin}/agents.md`,
    });
  }
  if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) {
    return jsonCors({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/oauth/authorize`,
      token_endpoint: `${url.origin}/oauth/token`,
      registration_endpoint: `${url.origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['documents'],
      service_documentation: `${url.origin}/agents.md`,
    });
  }
  if (path === '/oauth/register' && request.method === 'POST') return register(request, env);
  if (path === '/oauth/authorize' && request.method === 'GET') return authorizePage(request, env, url);
  if (path === '/oauth/authorize' && request.method === 'POST') return authorizeDecision(request, env, url);
  if (path === '/oauth/token' && request.method === 'POST') return token(request, env);
  return oauthError('not_found', 'No such endpoint.', 404);
}

// ---- registration ----

function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    if (x.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
    // Native apps' private schemes (com.example.app:/callback), but nothing that runs code.
    return /^[a-z][a-z0-9+.-]*:$/.test(x.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(x.protocol);
  } catch { return false; }
}

async function register(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (env.LOOSE_LIMIT && !(await env.LOOSE_LIMIT.limit({ key: `register:${ip}` })).success) return oauthError('slow_down', 'Too many registrations from here just now.', 429);
  let b;
  try { b = await request.json(); } catch { return oauthError('invalid_client_metadata', 'Send JSON.'); }
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError('invalid_redirect_uri', 'redirect_uris must be https (or http on localhost) addresses.');
  const name = String(b.client_name || 'An MCP client').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) || 'An MCP client';
  const id = `kc_${randomId(20)}`;
  await env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').bind(id, name, JSON.stringify(uris), Date.now()).run();
  return jsonCors({
    client_id: id, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }, 201);
}

async function client(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').bind(id).first();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

// ---- authorization ----

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Keel</title><link rel="stylesheet" href="/css/keel.css"></head>
<body><header class="bar"><a class="brand" href="/"><img src="/img/keel.svg" alt="" width="24" height="24"> Keel</a></header>
<div class="auth"><div class="card">${body}</div></div></body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*" },
  });
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function checkRequest(env, p) {
  const c = await client(env, p.get('client_id'));
  if (!c) return { fatal: 'This app isn\'t registered with Keel (unknown client_id). Try connecting it again.' };
  const redirect = p.get('redirect_uri');
  if (!redirect || !c.redirect_uris.includes(redirect)) return { fatal: 'The app gave a return address it didn\'t register.' };
  if (p.get('response_type') !== 'code') return { c, redirect, error: 'unsupported_response_type' };
  if (!p.get('code_challenge') || p.get('code_challenge_method') !== 'S256') return { c, redirect, error: 'invalid_request', description: 'PKCE with S256 is required.' };
  return { c, redirect };
}

function back(redirect, params) {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

async function authorizePage(request, env, url) {
  const p = url.searchParams;
  const r = await checkRequest(env, p);
  if (r.fatal) return page('Can\'t connect', `<h1>Can't connect</h1><p class="sub">${esc(r.fatal)}</p>`, 400);
  if (r.error) return back(r.redirect, { error: r.error, error_description: r.description, state: p.get('state') });
  const user = await currentUser(env, request).catch(() => null);
  if (!user || user.via === 'token') return Response.redirect(`${url.origin}/?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => (p.get(k) !== null ? `<input type="hidden" name="${k}" value="${esc(p.get(k))}">` : '')).join('');
  return page(`Connect ${r.c.name}`, `
    <h1>Connect ${esc(r.c.name)}?</h1>
    <p class="sub">It will be able to open, read and edit every Keel document you can, as you (${esc(user.email)}), and make new ones. Its changes show up live, labelled with its name.</p>
    <p class="meta">It goes back to <b>${esc(new URL(r.redirect).host || r.redirect)}</b>. Disconnect it any time from your name → API tokens and agents.</p>
    <form method="post" action="/oauth/authorize" style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">${hidden}
      <button class="btn" name="decision" value="deny">Cancel</button>
      <button class="btn primary" name="decision" value="allow">Allow</button>
    </form>`);
}

async function authorizeDecision(request, env, url) {
  // A form post: only from this site's own consent page.
  if (request.headers.get('origin') !== url.origin) return page('Can\'t connect', '<h1>Can\'t connect</h1><p class="sub">That request didn\'t come from Keel\'s own page.</p>', 403);
  const form = await request.formData();
  const p = new URLSearchParams([...form.entries()].map(([k, v]) => [k, String(v)]));
  const r = await checkRequest(env, new URLSearchParams([...p, ['response_type', 'code']]));
  if (r.fatal) return page('Can\'t connect', `<h1>Can't connect</h1><p class="sub">${esc(r.fatal)}</p>`, 400);
  if (r.error) return back(r.redirect, { error: r.error, error_description: r.description, state: p.get('state') });
  const user = await currentUser(env, request).catch(() => null);
  if (!user || user.via === 'token') return Response.redirect(`${url.origin}/`, 302);
  if (p.get('decision') !== 'allow') return back(r.redirect, { error: 'access_denied', state: p.get('state') });
  const code = randomId(32);
  await env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(code), r.c.id, user.id, r.redirect, p.get('code_challenge'), Date.now() + CODE_MS)
    .run();
  return back(r.redirect, { code, state: p.get('state'), iss: url.origin });
}

// ---- tokens ----

async function readForm(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return new URLSearchParams(Object.entries(await request.json().catch(() => ({}))).map(([k, v]) => [k, String(v)]));
  return new URLSearchParams(await request.text());
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function issue(env, c, userId) {
  const access = await createToken(env, userId, { name: `${c.name} (connected app)`, days: ACCESS_DAYS });
  const refresh = `kr_${randomId(32)}`;
  await env.DB.prepare('INSERT INTO oauth_refresh (token_hash, client_id, user_id, api_token_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(refresh), c.id, userId, access.id, Date.now() + REFRESH_DAYS * 86400_000)
    .run();
  return jsonCors({ access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_DAYS * 86400, refresh_token: refresh, scope: 'documents' });
}

async function token(request, env) {
  const p = await readForm(request);
  const c = await client(env, p.get('client_id'));
  if (!c) return oauthError('invalid_client', 'Unknown client_id.', 401);
  if (p.get('grant_type') === 'authorization_code') {
    const code = p.get('code') || '';
    const row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(await sha256(code)).first();
    if (row) await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').bind(row.code_hash).run(); // one use only
    if (!row || row.client_id !== c.id || row.expires_at < Date.now()) return oauthError('invalid_grant', 'That code is invalid, used or expired.');
    if (p.get('redirect_uri') && p.get('redirect_uri') !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri doesn\'t match.');
    const verifier = p.get('code_verifier') || '';
    if (verifier.length < 43 || verifier.length > 128) return oauthError('invalid_grant', 'code_verifier is required (PKCE).');
    if (b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) !== row.challenge) return oauthError('invalid_grant', 'code_verifier doesn\'t match.');
    return issue(env, c, row.user_id);
  }
  if (p.get('grant_type') === 'refresh_token') {
    const row = await env.DB.prepare('SELECT * FROM oauth_refresh WHERE token_hash = ?').bind(await sha256(p.get('refresh_token') || '')).first();
    if (!row || row.client_id !== c.id || row.expires_at < Date.now()) return oauthError('invalid_grant', 'That refresh token is invalid or expired.');
    // Revoked on the website (its access token is gone): the connection is over.
    const live = await env.DB.prepare('SELECT id FROM api_tokens WHERE id = ?').bind(row.api_token_id).first();
    await env.DB.prepare('DELETE FROM oauth_refresh WHERE token_hash = ?').bind(row.token_hash).run();
    if (!live) return oauthError('invalid_grant', 'Access was revoked. Connect again.');
    await env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(row.api_token_id).run();
    return issue(env, c, row.user_id);
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

export { HttpError };
