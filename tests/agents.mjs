// Agent access, end to end against a running server (`npm run dev`; KEEL_URL to point elsewhere):
// API tokens, merging HTTP writes and conflicts, loose documents, the remote MCP endpoint, the
// keel CLI and its stdio MCP server, and (locally) the purge of expired loose documents.
//   node tests/agents.mjs          PURGE=0 skips the purge step (it edits the local D1 directly)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.KEEL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CLI = new URL('../public/keel.mjs', import.meta.url).pathname;
const run = Date.now().toString(36);
let passed = 0;
async function step(name, fn) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

async function http(path, { method = 'GET', body, token, cookie, expect } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expect !== undefined) assert.equal(res.status, expect, `${method} ${path}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  else assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return { data, res };
}

const design = (name, features, next_id = features.length + 1) => JSON.stringify({ format: 'solidcraft/57', name, units: 'mm', params: [], features, next_id }, null, 2);
const box = (id, name, depth = 10) => ({ id, name, type: 'box', suppressed: false, width: 10, height: 10, depth });

function cli(args, { env = {}, cwd, ok = true } = {}) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd, env: { ...process.env, XDG_CONFIG_HOME: cwd, KEEL_URL: BASE, KEEL_TOKEN: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!ok) assert.fail(`expected keel ${args.join(' ')} to fail`);
    return { out, code: 0 };
  } catch (e) {
    if (ok) throw new Error(`keel ${args.join(' ')} failed (${e.status}): ${e.stderr}${e.stdout}`);
    return { out: e.stdout + e.stderr, code: e.status };
  }
}

async function rpc(body, token, path = token ? '/mcp' : '/mcp/loose') {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, data: res.status === 202 ? null : await res.json() };
}
async function mcpTool(name, args, token) {
  const { data } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
  const text = data.result.content[0].text;
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { value, isError: !!data.result.isError, text };
}

let cookie, token, readToken, docId;
const dir = mkdtempSync(join(tmpdir(), 'keel-agents-'));

await step('sign up and make API tokens', async () => {
  const { res } = await http('/api/signup', { method: 'POST', body: { email: `agent-${run}@example.com`, name: 'Ada', password: 'correct horse' }, expect: 201 });
  cookie = res.headers.get('set-cookie').split(';')[0];
  token = (await http('/api/tokens', { method: 'POST', cookie, body: { name: 'Claude Code', scope: 'write' }, expect: 201 })).data.token.token;
  readToken = (await http('/api/tokens', { method: 'POST', cookie, body: { name: 'Reader', scope: 'read' }, expect: 201 })).data.token.token;
  assert.match(token, /^keel_/);
  const list = (await http('/api/tokens', { cookie })).data.tokens;
  assert.equal(list.length, 2);
  assert.ok(!JSON.stringify(list).includes(token), 'listing never shows a token');
});

await step('tokens: who they are, read-only, no minting', async () => {
  const me = (await http('/api/me', { token })).data.user;
  assert.equal(me.name, 'Ada');
  assert.equal(me.token.name, 'Claude Code');
  await http('/api/tokens', { token, expect: 403 });
  await http('/api/docs', { method: 'POST', token: readToken, body: { name: 'x' }, expect: 403 });
  await http('/api/me', { token: 'keel_nonsense', expect: 401 });
});

await step('HTTP writes merge, with mine, theirs and ask', async () => {
  docId = (await http('/api/docs', { method: 'POST', token, body: { name: 'Bracket', text: design('Bracket', [box(1, 'Base plate')]) }, expect: 201 })).data.document.id;
  const c1 = (await http(`/api/docs/${docId}/content`, { token })).data;
  // Two writers from the same base: the second is merged using the room's history (no base_text).
  const a = (await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c1.seq, text: design('Bracket', [box(1, 'Base plate'), box(2, 'Rib')]) } })).data;
  assert.equal(a.merged, false);
  const b = (await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c1.seq, text: design('Bracket', [box(1, 'Base plate'), box(2, 'Boss')]) } })).data;
  assert.equal(b.merged, true);
  const names = JSON.parse(b.text).features.map((f) => f.name);
  assert.deepEqual(names, ['Base plate', 'Rib', 'Boss']);
  // Same field both sides.
  const c2 = (await http(`/api/docs/${docId}/content`, { token })).data;
  const edit = (depth) => { const d = JSON.parse(c2.text); d.features[0].depth = depth; return JSON.stringify(d, null, 2); };
  await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c2.seq, text: edit(20) } });
  const ask = await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c2.seq, text: edit(30), on_conflict: 'ask' }, expect: 409 });
  assert.equal(ask.data.conflicts[0].path, 'feature 1.depth');
  assert.deepEqual([ask.data.conflicts[0].base, ask.data.conflicts[0].mine, ask.data.conflicts[0].theirs], [10, 30, 20]);
  assert.equal(JSON.parse(ask.data.current.text).features[0].depth, 20, 'ask saves nothing');
  const theirs = (await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c2.seq, text: edit(30), on_conflict: 'theirs' } })).data;
  assert.equal(theirs.conflicts[0].kept, 'theirs');
  const mine = (await http(`/api/docs/${docId}/content`, { method: 'PUT', token, body: { base: c2.seq, text: edit(40) } })).data;
  assert.equal(JSON.parse(mine.text).features[0].depth, 40);
  await http(`/api/docs/${docId}/content`, { method: 'PUT', token: readToken, body: { base: mine.seq, text: edit(50) }, expect: 403 });
});

let looseKey, looseId;
await step('loose documents: no account, a key, one document, a deletion date', async () => {
  const made = await http('/api/loose', { method: 'POST', body: { name: 'Scratch', by: 'Claude' }, expect: 201 });
  const r = made.data;
  // The server's clock, not this computer's (which may be off).
  const serverNow = Date.parse(made.res.headers.get('date')) || Date.now();
  looseKey = r.key; looseId = r.document.id;
  assert.match(r.url, new RegExp(`/d/${looseId}#key=keel_`));
  const days = (await http('/api/config')).data.loose_days;
  assert.ok(Math.abs(r.document.expires_at - (serverNow + days * 86400_000)) < 120_000, 'deleted LOOSE_DAYS after creation');
  assert.match(r.note, /DELETED/);
  const doc = (await http(`/api/docs/${looseId}`, { token: looseKey })).data.document;
  assert.equal(doc.role, 'owner');
  assert.equal(doc.expires_at, r.document.expires_at);
  await http('/api/docs', { token: looseKey, expect: 403 });
  await http(`/api/docs/${docId}`, { token: looseKey, expect: 403 });
  await http('/api/tokens', { token: looseKey, expect: 403 });
});

await step('remote MCP: signed in, and without an account', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.data.result.serverInfo.name, 'keel');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).data.result.tools.map((t) => t.name);
  assert.ok(tools.includes('write_document') && tools.includes('create_document'));

  const listed = await mcpTool('list_documents', {}, token);
  assert.ok(listed.value.some((d) => d.id === docId));
  const anon = await mcpTool('list_documents', {});
  assert.ok(anon.isError);

  const made = (await mcpTool('create_document', { name: 'Agent scratch', design: design('Agent scratch', [box(1, 'Block')]) })).value;
  assert.match(made.key, /^keel_/);
  const read = await mcpTool('read_document', { id: made.key });
  assert.match(read.text, /seq 1/);
  const w = (await mcpTool('write_document', { id: made.key, base_seq: 1, design: design('Agent scratch', [box(1, 'Block'), box(2, 'Slot')]) })).value;
  assert.equal(w.saved, true);
  const stale = (await mcpTool('write_document', { id: made.key, base_seq: 1, design: design('Agent scratch', [box(1, 'Block', 99)]), on_conflict: 'ask' })).value;
  assert.equal(stale.saved, true, 'no clash: a different field merges cleanly');
  const clash = (await mcpTool('write_document', { id: made.key, base_seq: 1, design: design('Agent scratch', [box(1, 'Block', 5)]), on_conflict: 'ask' })).value;
  assert.equal(clash.saved, false);
  assert.equal(clash.conflicts[0].path, 'feature 1.depth');
  const v = (await mcpTool('save_version', { id: made.key, name: 'Checkpoint' })).value;
  assert.equal(v.name, 'Checkpoint');
  const bad = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'keel_wrong');
  assert.equal(bad.status, 401);
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(res.status, 401, '/mcp without a token asks for sign-in');
  assert.match(res.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

await step('typed edits and changes, without a browser', async () => {
  const c = (await http(`/api/docs/${docId}/content`, { token })).data;
  const r = (await mcpTool('edit_document', { id: docId, edits: [
    { op: 'rename', feature: 'Rib', name: 'Rib (left)' },
    { op: 'set', feature: 1, path: 'depth', value: 12 },
    { op: 'set_parameter', name: 'wall', expr: '3 mm' },
    { op: 'add', feature: { type: 'box', width: 5, height: 5, depth: 5 } },
  ] }, token)).value;
  assert.equal(r.saved, true);
  assert.equal(r.done.length, 4);
  const d = JSON.parse((await http(`/api/docs/${docId}/content`, { token })).data.text);
  const added = d.features[d.features.length - 1];
  assert.equal(added.name, 'Box', 'a new feature gets a name from its type');
  assert.equal(d.next_id, added.id + 1);
  const ch = (await mcpTool('get_changes', { id: docId, since_seq: c.seq }, token)).value;
  assert.match(ch.summary, /added "Box"/);
  assert.match(ch.summary, /wall/);
  const bad = await mcpTool('edit_document', { id: docId, edits: [{ op: 'rename', feature: 'Nope', name: 'x' }] }, token);
  assert.ok(bad.isError && /No feature "Nope"/.test(bad.text));
  const noHost = await mcpTool('inspect_model', { id: docId }, token);
  assert.ok(noHost.isError && /No browser tab/.test(noHost.text), 'a clear answer when no tab can run the modeller');
});

await step('OAuth: register, consent, PKCE, token, refresh, revoke', async () => {
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.code_challenge_methods_supported[0], 'S256');
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test connector', redirect_uris: ['http://localhost:9999/cb'] }) })).json();
  const verifier = 'v'.repeat(30) + run.padEnd(20, 'x');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' });
  const anon = await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location'), /\/\?next=%2Foauth%2Fauthorize/, 'not signed in: off to sign in first');
  const consent = await (await fetch(`${meta.authorization_endpoint}?${q}`, { headers: { cookie } })).text();
  assert.match(consent, /Connect Test connector\?/);
  const form = new URLSearchParams([...q, ['decision', 'allow']]);
  form.delete('response_type');
  const cross = await fetch(meta.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(cross.status, 403, 'consent can\'t be posted from another site');
  const ok = await fetch(meta.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { cookie, origin: BASE, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const back = new URL(ok.headers.get('location'));
  assert.equal(back.searchParams.get('state'), 'st8');
  const code = back.searchParams.get('code');
  const tok = (body) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: 'w'.repeat(50) })).status, 400, 'wrong verifier');
  const code2 = new URL((await fetch(meta.authorization_endpoint, { method: 'POST', redirect: 'manual', headers: { cookie, origin: BASE, 'content-type': 'application/x-www-form-urlencoded' }, body: form })).headers.get('location')).searchParams.get('code');
  const t = await (await tok({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier })).json();
  assert.match(t.access_token, /^keel_/);
  assert.equal((await tok({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: 'http://localhost:9999/cb', code_verifier: verifier })).status, 400, 'a code works once');
  const listed = await mcpTool('list_documents', {}, t.access_token);
  assert.ok(listed.value.some((d) => d.id === docId), 'the OAuth token works on /mcp');
  const t2 = await (await tok({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: reg.client_id })).json();
  assert.match(t2.access_token, /^keel_/);
  await http('/api/me', { token: t.access_token, expect: 401 });
  const mine = (await http('/api/tokens', { cookie })).data.tokens.find((x) => x.name === 'Test connector (connected app)');
  assert.ok(mine, 'the connection shows among API tokens');
  await http(`/api/tokens/${mine.id}`, { method: 'DELETE', cookie });
  assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: reg.client_id })).status, 400, 'revoked on the website: refresh fails');
});

await step('keel CLI: link, push, pull with merge, conflicts, local merge', async () => {
  const env = { KEEL_TOKEN: token };
  writeFileSync(join(dir, 'part.sc'), design('Part', [box(1, 'Body')]));
  const made = cli(['new', 'Part', '--from', 'part.sc'], { env, cwd: dir }).out;
  const id = /: (\w+)\n/.exec(made)[1];
  assert.ok(existsSync(join(dir, '.part.sc.keel')));
  // Edit locally and push.
  writeFileSync(join(dir, 'part.sc'), design('Part', [box(1, 'Body'), box(2, 'Fillet edge')]));
  assert.match(cli(['push', 'part.sc'], { env, cwd: dir }).out, /Sent/);
  // Someone edits remotely while we edit locally; pull merges, push sends.
  const c = (await http(`/api/docs/${id}/content`, { token })).data;
  const remote = JSON.parse(c.text); remote.features.push(box(3, 'Remote hole')); remote.next_id = 4;
  await http(`/api/docs/${id}/content`, { method: 'PUT', token, body: { base: c.seq, text: JSON.stringify(remote, null, 2) } });
  const local = JSON.parse(readFileSync(join(dir, 'part.sc'), 'utf8')); local.features[0].depth = 33;
  writeFileSync(join(dir, 'part.sc'), JSON.stringify(local, null, 2));
  assert.match(cli(['status', 'part.sc'], { env, cwd: dir }).out, /both changed/);
  assert.match(cli(['pull', 'part.sc'], { env, cwd: dir }).out, /kept, merged/);
  const merged = JSON.parse(readFileSync(join(dir, 'part.sc'), 'utf8'));
  assert.equal(merged.features.length, 3);
  assert.equal(merged.features[0].depth, 33);
  cli(['push', 'part.sc'], { env, cwd: dir });
  assert.match(cli(['status', 'part.sc'], { env, cwd: dir }).out, /up to date/);
  // A real clash with --on-conflict ask: nothing sent, the file rebased, exit code 3.
  const c3 = (await http(`/api/docs/${id}/content`, { token })).data;
  const theirs = JSON.parse(c3.text); theirs.features[0].depth = 1;
  await http(`/api/docs/${id}/content`, { method: 'PUT', token, body: { base: c3.seq, text: JSON.stringify(theirs, null, 2) } });
  const mine = JSON.parse(readFileSync(join(dir, 'part.sc'), 'utf8')); mine.features[0].depth = 2;
  writeFileSync(join(dir, 'part.sc'), JSON.stringify(mine, null, 2));
  const ask = cli(['push', 'part.sc', '--on-conflict', 'ask'], { env, cwd: dir, ok: false });
  assert.equal(ask.code, 3);
  assert.match(ask.out, /feature 1\.depth: base 33, mine 2, theirs 1/);
  assert.equal(JSON.parse((await http(`/api/docs/${id}/content`, { token })).data.text).features[0].depth, 1, 'nothing sent');
  // Resolve by choosing 7, then push: no conflict now.
  const fix = JSON.parse(readFileSync(join(dir, 'part.sc'), 'utf8')); fix.features[0].depth = 7;
  writeFileSync(join(dir, 'part.sc'), JSON.stringify(fix, null, 2));
  cli(['push', 'part.sc', '--on-conflict', 'ask'], { env, cwd: dir });
  assert.equal(JSON.parse((await http(`/api/docs/${id}/content`, { token })).data.text).features[0].depth, 7);
  // Local files only.
  writeFileSync(join(dir, 'b.sc'), design('M', [box(1, 'A')]));
  writeFileSync(join(dir, 'm.sc'), design('M', [box(1, 'A', 5)]));
  writeFileSync(join(dir, 't.sc'), design('M', [box(1, 'A', 6)]));
  const m = cli(['merge', 'b.sc', 'm.sc', 't.sc', '-o', 'out.sc', '--prefer', 'theirs'], { cwd: dir, ok: false });
  assert.equal(m.code, 3);
  assert.equal(JSON.parse(readFileSync(join(dir, 'out.sc'), 'utf8')).features[0].depth, 6);
  assert.match(cli(['check', 'out.sc'], { cwd: dir }).out, /1 features/);
});

await step('keel CLI without an account: a loose file to resume from', async () => {
  writeFileSync(join(dir, 'loose.sc'), design('Loose', [box(1, 'Plate')]));
  const out = cli(['new', 'Loose', '--from', 'loose.sc'], { cwd: dir }).out;
  assert.match(out, /Key \(the only way back in/);
  assert.match(out, /DELETED on/);
  const link = JSON.parse(readFileSync(join(dir, '.loose.sc.keel'), 'utf8'));
  assert.match(link.key, /^keel_/);
  writeFileSync(join(dir, 'loose.sc'), design('Loose', [box(1, 'Plate'), box(2, 'Tab')]));
  cli(['push', 'loose.sc'], { cwd: dir });
  assert.match(cli(['cat', link.key], { cwd: dir }).out, /"Tab"/);
  assert.match(cli(['status', 'loose.sc'], { cwd: dir }).out, /up to date[\s\S]*DELETED/);
});

await step('keel mcp (stdio): local tools and shared ones', async () => {
  const child = spawn('node', [CLI, 'mcp'], { cwd: dir, env: { ...process.env, XDG_CONFIG_HOME: dir, KEEL_URL: BASE, KEEL_TOKEN: token } });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); }
  });
  let n = 0;
  const ask = (method, params) => new Promise((res) => { const id = ++n; replies.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const callTool = async (name, args) => { const r = await ask('tools/call', { name, arguments: args }); assert.ok(!r.result.isError, r.result.content[0].text); return JSON.parse(r.result.content[0].text); };
  await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const names = (await ask('tools/list', {})).result.tools.map((t) => t.name);
  for (const t of ['pull_document', 'push_document', 'merge_files', 'upload_file', 'read_document']) assert.ok(names.includes(t), t);
  const p = await callTool('pull_document', { id: docId, path: join(dir, 'bracket.sc') });
  assert.equal(p.id, docId);
  const d = JSON.parse(readFileSync(p.file, 'utf8')); d.features.push(box(d.next_id, 'Gusset')); d.next_id++;
  writeFileSync(p.file, JSON.stringify(d, null, 2));
  const s = await callTool('push_document', { path: p.file });
  assert.equal(s.saved, true);
  assert.ok((await callTool('list_documents', {})).some((x) => x.id === docId));
  child.kill();
});

await step('format reference without a browser', async () => {
  const overview = (await mcpTool('describe_format', {}, token)).value;
  assert.match(overview.format, /^solidcraft\//);
  assert.ok(overview.examples.includes('sketch and extrude'));
  const ex = (await mcpTool('describe_format', { topic: 'extrude' }, token)).value;
  assert.ok(ex.examples['sketch and extrude'].features.some((f) => f.type === 'extrude'));
  const cmds = (await mcpTool('list_commands', { filter: 'solid.fillet' })).value;
  assert.equal(cmds.commands[0].id, 'solid.fillet');
  assert.ok(!(await mcpTool('list_commands', { filter: 'file.' })).value.commands.some((c) => c.id.startsWith('file.')), 'file commands are not offered');
});

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (process.env.HOST !== '0' && existsSync(CHROME)) {
  await step('a host tab: kernel commands, inspection, checks, screenshots, presence', async () => {
    const { chromium } = await import('@playwright/test');
    const made = (await mcpTool('create_document', { name: 'Hosted', by: 'Claude' })).value;
    const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu'] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
      await page.goto(`${BASE}/d/${made.id}?host=1#key=${made.key}`);
      await page.waitForSelector('.banner', { timeout: 180_000 });
      const ran = await mcpTool('run_commands', { id: made.key, commands: [{ command: 'solid.box', params: { length: 40, width: 30, height: 8, name: 'Base plate', body_name: 'Plate' } }], screenshot: 'iso' });
      const res = JSON.parse(ran.text);
      assert.equal(res.ok, true);
      assert.equal(res.saved, true);
      const { data } = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'run_commands', arguments: { id: made.key, commands: [{ command: 'solid.cylinder', params: { radius: 3, height: 8, center: [20, 15, 0], operation: 'cut', name: 'Hole' } }], screenshot: 'top' } } });
      assert.equal(data.result.content[1].type, 'image');
      assert.ok(data.result.content[1].data.length > 5000);
      const t1 = Date.now();
      const plain = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'screenshot', arguments: { id: made.key } } });
      assert.equal(plain.data.result.content[0].type, 'image', 'a screenshot with no view');
      assert.ok(Date.now() - t1 < 15_000, `no view: answered in ${Date.now() - t1} ms`);
      const again = await mcpTool('inspect_model', { id: made.key });
      assert.equal(again.value.rebuilds, true, 'the host tab still answers afterwards');
      const fail = JSON.parse((await mcpTool('run_commands', { id: made.key, commands: [{ command: 'solid.fillet', params: { radius: 2 } }] })).text);
      assert.equal(fail.ok, false);
      assert.match(fail.failed.error, /edges/);
      const blocked = await mcpTool('run_commands', { id: made.key, commands: [{ command: 'file.export', params: { path: '/x.stl' } }] });
      assert.ok(blocked.isError);
      const ins = (await mcpTool('inspect_model', { id: made.key, measure: true })).value;
      assert.equal(ins.rebuilds, true);
      assert.ok(ins.bodies[0].volume_mm3 < 40 * 30 * 8 - 20, `the hole was cut: volume ${ins.bodies[0].volume_mm3}`);
      // A typed edit, rebuilt and checked by the kernel in the host tab.
      const e = (await mcpTool('edit_document', { id: made.key, edits: [{ op: 'set', feature: 'Base plate', path: 'height', value: 12 }], check: true })).value;
      assert.equal(e.check?.rebuilds, true, JSON.stringify(e).slice(0, 600));
      const ins2 = (await mcpTool('inspect_model', { id: made.key, measure: true, at_seq: e.seq })).value;
      assert.ok(ins2.bodies[0].volume_mm3 > ins.bodies[0].volume_mm3, 'the edit reached the kernel');
      // A change the modeller refuses: reported at once, and fixing it recovers.
      const t0 = Date.now();
      const broken = (await mcpTool('edit_document', { id: made.key, edits: [{ op: 'set', feature: 'Base plate', path: 'height', value: [1, 2] }], check: true })).value;
      assert.equal(broken.check.opens, false, JSON.stringify(broken).slice(0, 400));
      assert.ok(Date.now() - t0 < 15_000, 'no long wait');
      const fixed = (await mcpTool('edit_document', { id: made.key, edits: [{ op: 'set', feature: 'Base plate', path: 'height', value: '12' }], check: true })).value;
      assert.equal(fixed.check.rebuilds, true, JSON.stringify(fixed).slice(0, 400));
      const peers = await page.evaluate(() => [...document.querySelectorAll('#peers .avatar')].map((a) => a.title).join(' | '));
      assert.match(peers, /\(agent\)/, `an agent shows among the people here: ${peers}`);
      const versions = (await mcpTool('list_versions', { id: made.key })).value.versions;
      assert.ok(versions.some((v) => /^Before /.test(v.name)), 'a restore point before the agent\'s session');
    } finally {
      await browser.close();
    }
  });
}

if (process.env.PURGE !== '0' && /127\.0\.0\.1|localhost/.test(BASE)) {
  await step('expired loose documents are purged', async () => {
    execFileSync('wrangler', ['d1', 'execute', 'keel', '--local', '--command', `UPDATE documents SET expires_at = 1 WHERE id = '${looseId}'`], { stdio: 'ignore' });
    const res = await fetch(`${BASE}/__scheduled?cron=17+*+*+*+*`);
    assert.equal(res.status, 200);
    await http(`/api/docs/${looseId}`, { token: looseKey, expect: 401 });
  });
}

console.log(`\n${passed} steps passed`);
