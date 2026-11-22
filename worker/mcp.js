// Remote MCP server at /mcp (Streamable HTTP, stateless, JSON responses). Agents connect with no
// install:  claude mcp add --transport http keel https://<site>/mcp --header "Authorization: Bearer keel_..."
// Without the header it still works for loose documents (made with create_document, reached by key).
// Each tool call goes through Keel's own HTTP API (`api`), so access rules and merging are the same.

import { TOOLS, DESIGN_NOTE, handleRpc } from '../public/js/agent-tools.js';
import { looseDays } from './auth.js';

const MAX = 34 * 1024 * 1024;

export async function mcp(request, env, url, api) {
  if (request.method === 'GET' || request.method === 'DELETE') {
    // No server-initiated stream and no sessions.
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  // Browsers on other sites must not drive this with someone's cookies: tokens only, no cookies used.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return rpcError(null, -32600, 'Cross-site requests are refused.', 403);

  const auth = request.headers.get('authorization') || '';
  const own = /^Bearer\s+(keel_\S+)$/i.exec(auth)?.[1] || null;
  if (auth && !own) return rpcError(null, -32600, 'Authorization must be "Bearer keel_..." (an API token from the Keel website).', 401);

  let signedIn = false;
  if (own) {
    const me = await api(new Request(`${url.origin}/api/me`, { headers: { authorization: `Bearer ${own}` } }));
    if (me.status === 401) return rpcError(null, -32600, (await me.json()).error, 401);
    const { user } = await me.json();
    signedIn = !user.token?.document_id; // a document key behaves like a loose key
  }

  const ctx = {
    site: url.origin,
    signedIn,
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
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202 });
  return Response.json(out, { headers: { 'cache-control': 'no-store' } });
}

function rpcError(id, code, message, status = 400) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}

export { TOOLS };
