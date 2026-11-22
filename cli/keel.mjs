#!/usr/bin/env node
// keel: Keel documents and local SolidCraft design files (.sc), for people and AI agents.
// One file, no dependencies, Node 20+. Get it from any Keel site: curl -fsSLO https://<site>/keel.mjs
//
// Work on a Keel document as a local file:
//   keel pull <id|key> [file.sc]        save it to a file, linked to the document
//   keel push <file.sc> [--on-conflict mine|theirs|ask]
//                                       send your changes; merges with anyone editing live
//   keel status <file.sc>               unchanged, changed locally, changed remotely, or both
//   keel new <name> [--from file.sc] [--loose]
//                                       make a document (and link the file, given --from)
// No account: --loose (or no token) makes a loose document, reached only by the key it prints.
// It is DELETED 30 days after it's made (the site's setting). The key is kept next to the file.
//
// Local files only, no server:
//   keel merge <base.sc> <mine.sc> <theirs.sc> [-o out.sc] [--prefer mine|theirs]
//   keel check <file.sc>
//
// Account:  keel login --url https://<site> [--token keel_...] | logout | whoami | ls
// Other:    keel cat <id|key> | version <id|key> <name> | open <id|key>
//           keel host <id|key|file.sc>   open it in headless Chrome for agents: kernel checks,
//                                        screenshots and modelling commands (CHROME= to choose)
// Agents:   keel mcp    (an MCP server on stdio; Claude Code: claude mcp add keel -- node /path/to/keel.mjs mcp)
//
// The token comes from KEEL_TOKEN or ~/.config/keel/config.json (`keel login`, readable only by
// you). The site from KEEL_URL, the config, or a linked file. Never commit a token or a key.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mergeDesigns } from '../public/js/merge.js';
import { TOOLS, DESIGN_NOTE, MODELLING_GUIDE, runTool, handleRpc } from '../public/js/agent-tools.js';

const VERSION = '0.2.0';
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'keel', 'config.json');
const DEFAULT_SITE = 'https://keel.pebnum.com';

// ---------------------------------------------------------------- config and HTTP

function loadConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch {}
  const url = (process.env.KEEL_URL || file.url || DEFAULT_SITE).replace(/\/+$/, '');
  const token = process.env.KEEL_TOKEN || file.token || '';
  return { url, token };
}

class KeelError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

const isKey = (s) => typeof s === 'string' && s.startsWith('keel_');

// `key` (a loose document's) replaces the account token; `site` overrides the configured site.
async function call(path, { method = 'GET', body, key, site } = {}) {
  const cfg = loadConfig();
  const url = (site || cfg.url).replace(/\/+$/, '');
  const token = key || cfg.token;
  let res;
  try {
    res = await fetch(url + '/api' + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new KeelError(`Can't reach ${url}: ${e.cause?.message || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 401 && !token ? ' Sign in with `keel login`, or use a loose document\'s key.' : '';
    throw new KeelError((data.error || `${res.status} ${res.statusText}`) + hint, res.status, data);
  }
  return data;
}

// Which document an id or key means: {id, key}.
async function target(ref, site) {
  if (!isKey(ref)) return { id: ref, key: null };
  const { user } = await call('/me', { key: ref, site });
  if (!user.token?.document_id) throw new KeelError('That is an account token, not a document key.');
  return { id: user.token.document_id, key: ref };
}

const docUrl = (site, id, key) => `${site}/d/${id}${key ? `#key=${key}` : ''}`;
const deletion = (t) => (t ? `It will be DELETED on ${new Date(t).toLocaleString()}.` : '');

// ---------------------------------------------------------------- linked files
// Next to `Part.sc` lives `.Part.sc.keel`: the site, the document, its key if loose, and the design
// as last pulled or pushed (the base the next merge starts from). It holds the key: keep it private.

const sidecar = (file) => join(dirname(file), `.${basename(file)}.keel`);
const safeName = (name) => String(name || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Untitled';

function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

function readLink(file) {
  try { return JSON.parse(readFileSync(sidecar(file), 'utf8')); } catch {
    throw new KeelError(`${file} isn't linked to a Keel document. \`keel pull <id> ${basename(file)}\` gets one; \`keel new <name> --from ${basename(file)}\` uploads this one.`);
  }
}
const writeLink = (file, link) => writeAtomic(sidecar(file), JSON.stringify(link), 0o600);

function checkDesign(text, where = 'design') {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new KeelError(`${where} isn't valid JSON: ${e.message}`); }
  if (!d || typeof d.format !== 'string' || !Array.isArray(d.features)) throw new KeelError(`${where} isn't a SolidCraft design (it needs a "format" string and a "features" list).`);
  return d;
}

// Bring a linked file up to date with the document. Local changes are kept: merged onto the newer
// design (prefer decides fields both changed), so the file then holds changes still to push.
async function pull(ref, file, { force = false, prefer = 'mine' } = {}) {
  let link = null;
  if (file && existsSync(resolve(file))) { try { link = readLink(resolve(file)); } catch {} }
  const site = link?.url || loadConfig().url;
  const t = ref ? await target(ref, site) : { id: link?.id, key: link?.key || null };
  if (!t.id) throw new KeelError('Which document? Give its id or key.');
  const [{ document: doc }, content] = await Promise.all([call(`/docs/${t.id}`, { key: t.key, site }), call(`/docs/${t.id}/content`, { key: t.key, site })]);
  file = resolve(file || `${safeName(doc.name)}.sc`);
  let text = content.text, conflicts = [], merged = false;
  if (existsSync(file) && !force) {
    if (!link) try { link = readLink(file); } catch {}
    if (!link || link.id !== t.id) throw new KeelError(`${file} exists and isn't linked to this document. Choose another file name, or pass --force to overwrite it.`);
    const local = readFileSync(file, 'utf8');
    if (local !== link.base && local !== content.text) {
      checkDesign(local, file);
      const m = mergeDesigns(link.base, local, content.text, { prefer: prefer === 'theirs' ? 'theirs' : 'mine' });
      text = m.text; conflicts = m.details; merged = true;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, text);
  writeLink(file, { url: site, id: t.id, key: t.key || link?.key || null, name: doc.name, seq: content.seq, base: content.text, expires_at: doc.expires_at || null });
  return { file, id: t.id, name: doc.name, seq: content.seq, role: doc.role, merged, unpushed: text !== content.text, conflicts, expires_at: doc.expires_at || null };
}

async function push(file, { onConflict = 'mine' } = {}) {
  file = resolve(file);
  const link = readLink(file);
  const text = readFileSync(file, 'utf8');
  if (text === link.base) return { file, id: link.id, seq: link.seq, unchanged: true, merged: false, conflicts: [] };
  checkDesign(text, file);
  let r;
  try {
    r = await call(`/docs/${link.id}/content`, { method: 'PUT', key: link.key, site: link.url, body: { base: link.seq, text, base_text: link.base, on_conflict: onConflict } });
  } catch (e) {
    if (e.status === 409 && e.data?.conflicts) {
      // 'ask': nothing saved. Merge here instead, keeping mine, so the file sits on the newest
      // design with the clashes listed; the agent or person fixes them and pushes again.
      const p = await pull(null, file, { prefer: 'mine' });
      return { file, id: link.id, seq: p.seq, saved: false, needsResolving: true, conflicts: p.conflicts };
    }
    throw e;
  }
  const final = r.text ?? text; // when merged, the server sends the merged design back
  if (final !== text) writeAtomic(file, final);
  writeLink(file, { ...link, seq: r.seq, base: final });
  return { file, id: link.id, seq: r.seq, saved: !r.unchanged, unchanged: !!r.unchanged, merged: r.merged, conflicts: r.conflicts || [] };
}

async function status(file) {
  file = resolve(file);
  const link = readLink(file);
  const local = readFileSync(file, 'utf8');
  const c = await call(`/docs/${link.id}/content`, { key: link.key, site: link.url });
  const mine = local !== link.base, theirs = c.seq !== link.seq;
  return { file, id: link.id, local_changes: mine, remote_changes: theirs, seq: link.seq, remote_seq: c.seq, url: docUrl(link.url, link.id), ...(link.key ? { key_in: sidecar(file) } : {}), expires_at: link.expires_at,
    state: mine && theirs ? 'both changed: `keel pull` merges them, then push' : mine ? 'changed locally: push to send' : theirs ? 'changed remotely: pull to update' : 'up to date' };
}

// Upload a local file as a new document and link it.
async function create(name, { from, loose = false, by } = {}) {
  const cfg = loadConfig();
  const text = from ? readFileSync(from, 'utf8') : undefined;
  if (text) checkDesign(text, from);
  let id, key = null, expires = null, note = '';
  if (loose || !cfg.token) {
    const r = await call('/loose', { method: 'POST', key: null, body: { name, text, by } });
    ({ id } = r.document); key = r.key; expires = r.document.expires_at; note = r.note;
  } else {
    ({ id } = (await call('/docs', { method: 'POST', body: { name, ...(text ? { text } : {}) } })).document);
  }
  let file = null;
  if (from) {
    file = resolve(from);
    const c = await call(`/docs/${id}/content`, { key, site: cfg.url });
    writeLink(file, { url: cfg.url, id, key, name, seq: c.seq, base: text, expires_at: expires });
  }
  return { id, name, key, url: docUrl(cfg.url, id, key), file, expires_at: expires, note };
}

// ---------------------------------------------------------------- agent host
// A headless Chrome with the document open in host mode (/d/<id>?host=1), so agents' kernel
// checks, screenshots and modelling commands have a tab to run in. It runs until stopped.

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new KeelError('No Chrome found. Install Chrome or Chromium, or set CHROME to its path.');
  return hit;
}

async function host(ref, { detached = false } = {}) {
  let site = loadConfig().url, id, key;
  if (ref && ref.endsWith('.sc') && existsSync(sidecar(resolve(ref)))) {
    const link = readLink(resolve(ref));
    ({ id } = link); key = link.key; site = link.url;
  } else {
    if (!ref) throw new KeelError('Which document? Give its id, key or linked file.');
    ({ id, key } = await target(ref, site));
  }
  const credential = key || loadConfig().token;
  if (!credential) throw new KeelError('Hosting an account document needs a token: run `keel login` or set KEEL_TOKEN.');
  const url = `${site}/d/${id}?host=1#key=${credential}`;
  const profile = join(tmpdir(), `keel-host-${id}`);
  mkdirSync(profile, { recursive: true });
  const chrome = findChrome();
  const child = spawn(chrome, ['--headless=new', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1400,900', url], { detached, stdio: 'ignore' });
  if (detached) child.unref();
  return { id, pid: child.pid, chrome, child, url: `${site}/d/${id}` };
}

// ---------------------------------------------------------------- command line

const HELP = (() => {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const top = lines.slice(0, lines.findIndex((l) => !l.startsWith('//')));
  return top.filter((l) => !l.startsWith('// Built from')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
})();

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a === '-o') {
      const [k, v] = (a === '-o' ? 'out' : a.slice(2)).split('=', 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

function showConflicts(list) {
  for (const c of list) {
    if (c.kind === 'deleted') console.log(`  conflict  ${c.path}: deleted on one side, edited on the other (it stays deleted)`);
    else console.log(`  conflict  ${c.path}: base ${short(c.base)}, mine ${short(c.mine)}, theirs ${short(c.theirs)} (kept ${c.kept})`);
  }
}
const short = (v) => { const s = JSON.stringify(v); return s === undefined ? 'none' : s.length > 60 ? s.slice(0, 57) + '...' : s; };

async function cli(argv) {
  const f = flags(argv);
  const [cmd, ...args] = f._;
  const need = (n, usage) => { if (args.length < n) throw new KeelError(`Usage: keel ${usage}`); };
  const cfg = loadConfig();
  switch (cmd) {
    case 'login': {
      const url = String(f.url || cfg.url).replace(/\/+$/, '');
      let token = typeof f.token === 'string' ? f.token : '';
      if (!token) {
        process.stderr.write(`Paste an API token from ${url} (your name, top right → API tokens): `);
        token = (await new Promise((res) => createInterface({ input: process.stdin }).once('line', res))).trim();
      }
      const res = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${token}` } }).catch((e) => { throw new KeelError(`Can't reach ${url}: ${e.message}`); });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KeelError(data.error || `HTTP ${res.status}`);
      mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
      const u = data.user;
      console.log(`Signed in to ${url} as ${u.name}, with the token "${u.token?.name}" (${u.token?.scope === 'read' ? 'read-only' : 'read and write'}). Saved to ${CONFIG}.`);
      return;
    }
    case 'logout':
      if (existsSync(CONFIG)) writeFileSync(CONFIG, JSON.stringify({ url: cfg.url }, null, 2) + '\n', { mode: 0o600 });
      console.log('Removed the token from this computer. It works until you revoke it on the website.');
      return;
    case 'whoami': {
      if (!cfg.token) return console.log(`Not signed in to ${cfg.url}. Loose documents still work.`);
      const { user: u } = await call('/me');
      console.log(`${u.name} <${u.email}> on ${cfg.url}, token "${u.token?.name}" (${u.token?.scope})`);
      return;
    }
    case 'ls': case 'list': {
      const { documents } = await call('/docs');
      if (f.json) return console.log(JSON.stringify(documents, null, 2));
      if (!documents.length) return console.log('No documents yet. `keel new "My part"` makes one.');
      for (const d of documents) console.log(`${d.id}  ${d.role.padEnd(5)}  ${new Date(d.updated_at).toLocaleString().padEnd(22)}  ${d.name}`);
      return;
    }
    case 'pull': {
      need(1, 'pull <id|key|file.sc> [file.sc] [--force] [--prefer mine|theirs]');
      const linked = args[0].endsWith('.sc') && existsSync(sidecar(resolve(args[0])));
      const r = linked ? await pull(null, args[0], { prefer: f.prefer }) : await pull(args[0], args[1], { force: !!f.force, prefer: f.prefer });
      console.log(`${r.file}: "${r.name}" at seq ${r.seq}${r.role === 'view' ? ', view only' : ''}.`);
      if (r.merged) console.log('Your local changes were kept, merged onto the newer design. Push to send them.');
      showConflicts(r.conflicts);
      if (r.expires_at) console.log(`Loose document. ${deletion(r.expires_at)}`);
      return;
    }
    case 'push': {
      need(1, 'push <file.sc> [--on-conflict mine|theirs|ask]');
      const r = await push(args[0], { onConflict: f['on-conflict'] || 'mine' });
      if (r.unchanged) return console.log('No changes to send.');
      if (r.needsResolving) {
        console.log(`Not sent: these clash with changes made since your last pull. ${r.file} now holds the newest design with your changes merged in (yours kept for each clash below). Fix what you want, then push again.`);
        showConflicts(r.conflicts);
        process.exitCode = 3;
        return;
      }
      const link = readLink(resolve(args[0]));
      console.log(`Sent. Now at seq ${r.seq}: ${docUrl(link.url, link.id)}`);
      if (r.merged) console.log(`Someone else changed it meanwhile; merged, and ${r.file} now holds the merged design.`);
      showConflicts(r.conflicts);
      return;
    }
    case 'status': {
      need(1, 'status <file.sc>');
      const s = await status(args[0]);
      console.log(`${s.file}: ${s.state} (local seq ${s.seq}, document seq ${s.remote_seq})\n${s.url}${s.expires_at ? `\nLoose document. ${deletion(s.expires_at)}` : ''}`);
      return;
    }
    case 'new': {
      need(1, 'new <name> [--from file.sc] [--loose] [--by "Name"]');
      const r = await create(args[0], { from: f.from, loose: !!f.loose, by: f.by });
      console.log(`Created "${r.name}": ${r.id}\n${r.url}`);
      if (r.key) console.log(`Key (the only way back in; shown once${r.file ? ', also saved next to the file' : ''}): ${r.key}\n${r.note}`);
      if (r.file) console.log(`${r.file} is linked to it: edit, then \`keel push ${basename(r.file)}\`.`);
      return;
    }
    case 'cat': { need(1, 'cat <id|key>'); const t = await target(args[0]); process.stdout.write((await call(`/docs/${t.id}/content`, { key: t.key })).text + '\n'); return; }
    case 'version': {
      need(2, 'version <id|key> <name>');
      const t = await target(args[0]);
      const v = await call(`/docs/${t.id}/versions`, { method: 'POST', key: t.key, body: { name: args.slice(1).join(' ') } });
      console.log(`Saved version "${v.name}" at seq ${v.seq}.`);
      return;
    }
    case 'open': { need(1, 'open <id|key>'); const t = await target(args[0]); console.log(docUrl(cfg.url, t.id, t.key)); return; }
    case 'merge': {
      need(3, 'merge <base.sc> <mine.sc> <theirs.sc> [-o out.sc] [--prefer mine|theirs]');
      const [b, m, t] = args.map((p) => readFileSync(p, 'utf8'));
      args.forEach((p, i) => checkDesign([b, m, t][i], p));
      const r = mergeDesigns(b, m, t, { prefer: f.prefer === 'theirs' ? 'theirs' : 'mine' });
      if (typeof f.out === 'string') { writeAtomic(resolve(f.out), r.text); console.log(`Merged into ${f.out}.`); } else process.stdout.write(r.text + '\n');
      if (r.details.length) { console.error(`${r.details.length} conflict(s):`); showConflicts(r.details); process.exitCode = 3; }
      return;
    }
    case 'check': {
      need(1, 'check <file.sc>');
      const d = checkDesign(readFileSync(args[0], 'utf8'), args[0]);
      const ids = d.features.map((x) => x.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
      const unnamed = d.features.filter((x) => !x.name).map((x) => x.id);
      const low = d.features.filter((x) => Number.isInteger(x.id) && x.id >= (d.next_id || 0)).map((x) => x.id);
      console.log(`${args[0]}: ${d.format}, ${d.features.length} features, ${(d.params || []).length} parameters.`);
      if (dup.length) console.log(`  duplicate feature ids: ${[...new Set(dup)].join(', ')}`);
      if (low.length) console.log(`  next_id (${d.next_id}) must be above every feature id; these aren't below it: ${low.join(', ')}`);
      if (unnamed.length) console.log(`  features without a name: ${unnamed.join(', ')}`);
      if (dup.length || low.length) process.exitCode = 3;
      console.log('This checks the file\'s structure only. Opening it in SolidCraft (or `solidcraft-cli`) rebuilds it with the real kernel.');
      return;
    }
    case 'host': {
      need(1, 'host <id|key|file.sc>');
      const h = await host(args[0]);
      console.log(`Hosting ${h.url} for agents in headless Chrome (pid ${h.pid}). The first start downloads the modeller (~32 MB). Ctrl-C stops it.`);
      await new Promise((res) => { h.child.on('exit', res); process.on('SIGINT', () => { h.child.kill(); res(); }); });
      return;
    }
    case 'mcp': return serveMcp();
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    case '--version': console.log(VERSION); return;
    default: throw new KeelError(`Unknown command "${cmd}". Run \`keel help\`.`);
  }
}

// ---------------------------------------------------------------- MCP server (stdio)

const LOCAL_TOOLS = [
  {
    name: 'pull_document',
    description: 'Save a Keel document to a local .sc file linked to it (SolidCraft opens .sc files; so can solidcraft-cli\'s MCP server, for edits checked by the real kernel). If the file is already linked and has unpushed changes, they are kept and merged onto the newer design, with any conflicts listed. Returns the path.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Document id or loose key. Omit to update an already linked file.' }, path: { type: 'string' }, force: { type: 'boolean', description: 'Overwrite local changes instead of merging.' }, prefer: { type: 'string', enum: ['mine', 'theirs'], description: 'Who wins a field both changed.' } } },
  },
  {
    name: 'push_document',
    description: 'Send a linked .sc file\'s changes to its Keel document, merged with anything changed since. on_conflict "mine" (default) or "theirs" picks the winner of a field both changed; "ask" sends nothing when they clash, rewrites the file onto the newest design with your changes merged in, and lists the conflicts so you can fix them and push again.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, on_conflict: { type: 'string', enum: ['mine', 'theirs', 'ask'] } }, required: ['path'] },
  },
  {
    name: 'file_status',
    description: 'Whether a linked .sc file and its Keel document have changed since the last pull or push.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'upload_file',
    description: 'Make a Keel document from a local .sc file and link the file to it, so pushes and pulls keep them in step. loose: true (or no account token) makes a loose document: no account, reached by the key saved next to the file, DELETED some days after it is made (the result says when).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, loose: { type: 'boolean' }, by: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'start_host',
    description: 'Open a document in headless Chrome on this computer as an agent tab, so inspect_model, screenshot, list_commands and run_commands work without anyone having it open. It keeps running in the background; the first start takes up to a minute (the modeller downloads and starts).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Document id, key, or a linked .sc file.' } }, required: ['id'] },
  },
  {
    name: 'merge_files',
    description: 'Three-way merge of local design files, no server needed: base (the common ancestor), mine and theirs. Writes the result to out (or returns it) and lists each conflict with its base, mine and theirs values; prefer picks the winner of a field both changed.',
    inputSchema: { type: 'object', properties: { base: { type: 'string' }, mine: { type: 'string' }, theirs: { type: 'string' }, out: { type: 'string' }, prefer: { type: 'string', enum: ['mine', 'theirs'] } }, required: ['base', 'mine', 'theirs'] },
  },
];

function serveMcp() {
  const cfg = loadConfig();
  const ctx = {
    site: cfg.url,
    signedIn: !!cfg.token,
    reads: new Map(),
    call: (path, opts = {}) => call(path, opts),
    async asset(path) {
      const res = await fetch(cfg.url + path).catch((e) => { throw new KeelError(`Can't reach ${cfg.url}: ${e.message}`); });
      if (!res.ok) throw new KeelError(`${path}: HTTP ${res.status}`);
      return res.json();
    },
  };
  const run = async (name, a) => {
    switch (name) {
      case 'pull_document': return pull(a.id, a.path, { force: !!a.force, prefer: a.prefer });
      case 'push_document': return push(a.path, { onConflict: a.on_conflict || 'mine' });
      case 'file_status': return status(a.path);
      case 'upload_file': return create(a.name || basename(a.path).replace(/\.sc$/, ''), { from: a.path, loose: !!a.loose, by: a.by });
      case 'start_host': {
        const h = await host(a.id, { detached: true });
        return { hosting: h.url, pid: h.pid, note: 'Give it up to a minute to load, then use inspect_model, screenshot or run_commands. Stop it by killing the pid.' };
      }
      case 'merge_files': {
        const [b, m, t] = [a.base, a.mine, a.theirs].map((p) => readFileSync(p, 'utf8'));
        const r = mergeDesigns(b, m, t, { prefer: a.prefer === 'theirs' ? 'theirs' : 'mine' });
        if (a.out) writeAtomic(resolve(a.out), r.text);
        return { conflicts: r.details, ...(a.out ? { written: resolve(a.out) } : { design: r.text }) };
      }
      default: return runTool(ctx, name, a);
    }
  };
  const opts = {
    ctx, run,
    tools: [...TOOLS, ...LOCAL_TOOLS],
    info: { name: 'keel', version: VERSION },
    instructions:
      `Keel is collaborative CAD; these tools reach Keel documents at ${cfg.url} (people may be editing them live) and local SolidCraft .sc files. ` +
      (cfg.token ? 'Signed in with an account token. ' : 'Not signed in: create_document and upload_file make loose documents (no account, reached by key, deleted after a set number of days). ') +
      'To edit as a file: pull_document, edit the .sc file (by hand, or with solidcraft-cli\'s MCP server for kernel-checked edits), then push_document. ' + MODELLING_GUIDE + ' ' + DESIGN_NOTE,
  };
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const reply = await handleRpc(msg, opts);
    if (reply) send(reply);
  });
}

// ---------------------------------------------------------------- main

const self = resolve(new URL(import.meta.url).pathname);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(`keel: ${e.message}`);
    process.exit(e instanceof KeelError || e.status ? 1 : 2);
  });
}
