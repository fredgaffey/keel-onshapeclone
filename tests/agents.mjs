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

async function rpc(body, token) {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
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
  const r = (await http('/api/loose', { method: 'POST', body: { name: 'Scratch', by: 'Claude' }, expect: 201 })).data;
  looseKey = r.key; looseId = r.document.id;
  assert.match(r.url, new RegExp(`/d/${looseId}#key=keel_`));
  const days = (await http('/api/config')).data.loose_days;
  assert.ok(Math.abs(r.document.expires_at - (Date.now() + days * 86400_000)) < 120_000, 'deleted LOOSE_DAYS after creation');
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

if (process.env.PURGE !== '0' && /127\.0\.0\.1|localhost/.test(BASE)) {
  await step('expired loose documents are purged', async () => {
    execFileSync('wrangler', ['d1', 'execute', 'keel', '--local', '--command', `UPDATE documents SET expires_at = 1 WHERE id = '${looseId}'`], { stdio: 'ignore' });
    const res = await fetch(`${BASE}/__scheduled?cron=17+*+*+*+*`);
    assert.equal(res.status, 200);
    await http(`/api/docs/${looseId}`, { token: looseKey, expect: 401 });
  });
}

console.log(`\n${passed} steps passed`);
