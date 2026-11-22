// Remote MCP server (Streamable HTTP, stateless, JSON responses). Agents connect with no install:
//   /mcp        signed in: an API token in the Authorization header, or OAuth (claude.ai and
//               ChatGPT connectors, Claude Code's /mcp sign-in), which a 401 here starts.
//   /mcp/loose  no account: loose documents only, made with create_document and reached by key.
// Each tool call goes through Keel's own HTTP API (`api`), so access rules and merging are the same.

import { TOOLS, DESIGN_NOTE, handleRpc } from '../public/js/agent-tools.js';
import { looseDays } from './auth.js';
import { cors, resourceMetadataUrl } from './oauth.js';

const MAX = 34 * 1024 * 1024;

export async function mcp(request, env, url, api, { loose = false } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    // No server-initiated stream and no sessions.
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...cors } });
  }
  // Cookies are never used here (only bearer tokens), so any site may call it, as MCP web clients do.
  const auth = request.headers.get('authorization') || '';
  const own = loose ? null : /^Bearer\s+(keel_\S+)$/i.exec(auth)?.[1] || null;
  const challenge = { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(url)}"` };
  if (!loose && !own) {
    return rpcError(null, -32001, `Sign in: connect with OAuth, or send "Authorization: Bearer keel_..." (an API token from ${url.origin}). For no account, use ${url.origin}/mcp/loose.`, 401, challenge);
  }

  let signedIn = false;
  if (own) {
    const me = await api(new Request(`${url.origin}/api/me`, { headers: { authorization: `Bearer ${own}` } }));
    if (me.status === 401) return rpcError(null, -32001, (await me.json()).error, 401, challenge);
    const { user } = await me.json();
    signedIn = !user.token?.document_id; // a document key behaves like a loose key
  }

  const ctx = {
    site: url.origin,
    signedIn,
    async asset(path) {
      const res = await api(new Request(`${url.origin}${path}`));
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    },
    async call(path, { method = 'GET', body, key } = {}) {
      const token = key || own;
      const res = await api(new Request(`${url.origin}/api${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
      return data;
    },
  };

  const text = await request.text();
  if (text.length > MAX) return rpcError(null, -32600, 'Request too large.', 413);
  let msg;
  try { msg = JSON.parse(text); } catch { return rpcError(null, -32700, 'Parse error'); }

  const opts = {
    ctx,
    info: { name: 'keel', version: '0.2.0' },
    instructions:
      `Keel is collaborative CAD in the browser; these tools read and change Keel documents, which people may be editing live. ` +
      (signedIn ? 'You are signed in with an account token. ' : `You are not signed in: create_document makes a loose document (no account; it is deleted ${looseDays(env)} days after it is made) and returns a key to reach it. `) +
      DESIGN_NOTE,
  };
  const one = (m) => handleRpc(m, opts);
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202, headers: cors });
  return Response.json(out, { headers: { 'cache-control': 'no-store', ...cors } });
}

function rpcError(id, code, message, status = 400, headers = {}) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: { ...cors, ...headers } });
}

export { TOOLS };
