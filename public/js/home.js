import { api, esc, when, toast, initials, registerServiceWorker } from './api.js';
import * as local from './local.js';
import { ACCEPT, READABLE, UNIT_CHOICES, formatOf, nameFromFile } from './formats.js';

const root = document.getElementById('root');
const who = document.getElementById('who');
const net = document.getElementById('net');
let me = null;
let docs = [];
let view = 'all';
let query = '';

registerServiceWorker();
start();

async function start() {
  try {
    me = (await api('/me')).user;
    await local.setKv('me', me);
    await uploadOfflineDocs();
    showHome();
  } catch (e) {
    if (e.status === 0) {
      me = await local.getKv('me');
      if (me) return showHome(true);
      root.innerHTML = '<div class="auth"><div class="card"><h1>You\'re offline</h1><p class="sub">Sign in once while online and Keel keeps your designs on this device.</p></div></div>';
      return;
    }
    showAuth('signin');
  }
}

// ---------------- sign in / sign up ----------------

async function showAuth(mode) {
  who.innerHTML = '';
  let signupOpen = true;
  try { signupOpen = (await api('/config')).signup; } catch { /* offline */ }
  const up = mode === 'signup';
  root.innerHTML = `
    <div class="auth"><form class="card" id="auth" novalidate>
      <h1>${up ? 'Create your Keel account' : 'Sign in to Keel'}</h1>
      <p class="sub">${up ? 'Design together in the browser. Your work also stays on your device.' : 'Collaborative CAD in your browser.'}</p>
      ${up ? '<div class="field"><label for="name">Name</label><input id="name" type="text" autocomplete="name" required></div>' : ''}
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="8" required></div>
      <div class="err" id="err" role="alert"></div>
      <button class="btn primary" style="width:100%;justify-content:center" type="submit">${up ? 'Create account' : 'Sign in'}</button>
      ${signupOpen || !up ? `<p class="switch">${up ? 'Have an account? <a href="#" id="swap">Sign in</a>' : signupOpen ? 'New here? <a href="#" id="swap">Create an account</a>' : ''}</p>` : ''}
    </form></div>`;
  document.getElementById('swap')?.addEventListener('click', (e) => { e.preventDefault(); showAuth(up ? 'signin' : 'signup'); });
  const form = document.getElementById('auth');
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = '';
    const body = { email: form.email.value, password: form.password.value };
    if (up) body.name = form.name.value;
    try {
      me = (await api(up ? '/signup' : '/login', { method: 'POST', body })).user;
      // Signing in on the way somewhere (an OAuth consent page, say): go back there. Same site only.
      const next = new URLSearchParams(location.search).get('next');
      if (next && next.startsWith('/') && !next.startsWith('//')) return location.replace(next);
      await local.setKv('me', me);
      showHome();
    } catch (x) {
      err.textContent = x.message;
    }
  });
}

// ---------------- documents ----------------

async function showHome(offline = false) {
  net.hidden = !offline;
  who.innerHTML = `<button class="btn ghost" id="usermenu" title="${esc(me.email)}"><span class="avatar" style="background:#4f5d75">${esc(initials(me.name))}</span><span class="hide-narrow">${esc(me.name)}</span></button>`;
  const dev = offline ? false : await api('/config').then((c) => c.dev, () => false);
  if (dev) who.insertAdjacentHTML('afterbegin', '<span class="pill" style="color:#f2a541;border-color:#f2a541;margin-right:8px" title="DEV_AUTH=1: sign-in is skipped on localhost">Dev mode</span>');
  document.getElementById('usermenu').onclick = (e) => menu(e.currentTarget, [
    [`Signed in as ${me.email}`, null],
    ...(dev ? [['Switch user (dev)…', () => { const n = prompt('Become which user? (made if new)', 'Bob'); if (n) location.href = `/api/dev/as?name=${encodeURIComponent(n)}`; }]] : []),
    ['API tokens and agents…', () => tokensDialog()],
    ['Sign out', async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); location.reload(); }],
  ]);
  root.innerHTML = `
    <div class="home">
      <nav class="side">
        <button class="btn primary create" id="create">+ Create</button>
        <button class="btn" id="import" style="justify-content:center" title="STEP, IGES, STL, 3MF, OBJ, glTF, point clouds, DXF, KiCad, or a Keel/SolidCraft design. You can also drop a file anywhere here.">Import a file…</button>
        <div style="height:10px"></div>
        <button class="nav" data-view="all">All documents <span class="count" id="c-all"></span></button>
        <button class="nav" data-view="mine">Owned by me <span class="count" id="c-mine"></span></button>
        <button class="nav" data-view="shared">Shared with me <span class="count" id="c-shared"></span></button>
        <button class="nav" data-view="device">On this device <span class="count" id="c-device"></span></button>
        <div class="foot" id="backup"></div>
      </nav>
      <section class="main">
        <div class="toolbar">
          <h2 id="title">All documents</h2>
          <input type="text" id="search" placeholder="Search documents" aria-label="Search documents">
        </div>
        <div id="list"></div>
      </section>
    </div>`;
  root.querySelectorAll('.nav').forEach((b) => (b.onclick = () => { view = b.dataset.view; render(); }));
  document.getElementById('search').oninput = (e) => { query = e.target.value.toLowerCase(); render(); };
  document.getElementById('create').onclick = createDialog;
  document.getElementById('import').onclick = importFile;
  wireDrops();
  await load(offline);
  renderBackup();
}

async function load(offline) {
  const kept = await local.allDocs();
  const keptById = new Map(kept.map((d) => [d.id, d]));
  if (!offline) {
    try {
      docs = (await api('/docs')).documents;
      await local.setKv('docList', docs);
    } catch (e) {
      if (e.status !== 0) toast(e.message, 'error');
      offline = true;
      net.hidden = false;
    }
  }
  if (offline) docs = (await local.getKv('docList')) || [];
  // Designs only on this device (made offline, not uploaded yet).
  for (const d of kept) if (d.id.startsWith('local-') && !docs.some((x) => x.id === d.id)) docs.unshift({ id: d.id, name: d.name, role: 'owner', updated_at: d.savedAt, owner_name: me.name, pending: true });
  for (const d of docs) {
    const k = keptById.get(d.id);
    d.kept = !!k;
    d.unsynced = !!(k && k.local && k.local !== k.base);
  }
  render();
}

function render() {
  const titles = { all: 'All documents', mine: 'Owned by me', shared: 'Shared with me', device: 'On this device' };
  const filters = { all: () => true, mine: (d) => d.role === 'owner', shared: (d) => d.role !== 'owner', device: (d) => d.kept || d.pending };
  for (const [k, f] of Object.entries(filters)) document.getElementById(`c-${k}`).textContent = docs.filter(f).length || '';
  root.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  document.getElementById('title').textContent = titles[view];
  const rows = docs.filter(filters[view]).filter((d) => !query || d.name.toLowerCase().includes(query));
  const list = document.getElementById('list');
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${query ? 'No documents match.' : view === 'shared' ? 'Nothing has been shared with you yet.' : view === 'device' ? 'No documents are kept on this device yet. Use a document\'s ⋯ menu → Keep on device.' : 'No documents yet. Create one to start designing.'}</div>`;
    return;
  }
  list.innerHTML = `<table class="docs"><thead><tr><th>Name</th><th class="hide-narrow">Owner</th><th>Modified</th><th></th></tr></thead><tbody>
    ${rows.map((d) => `<tr data-id="${esc(d.id)}">
      <td><div class="docname"><span class="thumb">${esc(initials(d.name))}</span><span>${esc(d.name)}</span>
        ${d.pending ? '<span class="pill pending" title="Made while offline; uploads when you\'re back online">Not uploaded</span>' : ''}
        ${d.unsynced ? '<span class="pill pending" title="Changes made offline that haven\'t reached the server yet">Unsynced changes</span>' : ''}
        ${d.kept && !d.pending && !d.unsynced ? '<span class="pill offline" title="A copy is on this device">On device</span>' : ''}
        ${d.role === 'view' ? '<span class="pill">View only</span>' : ''}</div></td>
      <td class="hide-narrow">${d.role === 'owner' ? 'Me' : esc(d.owner_name)}</td>
      <td>${esc(when(d.updated_at))}${d.updated_by ? ` <span class="hide-narrow" style="color:var(--muted)">by ${esc(d.updated_by)}</span>` : ''}</td>
      <td style="text-align:right"><button class="btn ghost rowmenu" aria-label="Document actions">⋯</button></td>
    </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tbody tr').forEach((tr) => {
    const d = docs.find((x) => x.id === tr.dataset.id);
    tr.onclick = (e) => { if (!e.target.closest('.rowmenu')) location.href = `/d/${d.id}`; };
    tr.querySelector('.rowmenu').onclick = (e) => rowMenu(e.currentTarget, d);
  });
}

function rowMenu(anchor, d) {
  const items = [['Open', () => (location.href = `/d/${d.id}`)]];
  if (!d.pending) {
    if (d.role !== 'view') items.push(['Rename…', () => rename(d)]);
    items.push(['Download design file', () => downloadDoc(d)]);
    if (!d.kept) items.push(['Keep a copy on this device', () => keep(d)]);
  }
  if (d.role === 'owner' && !d.pending) items.push(null, ['Delete…', () => remove(d)]);
  if (d.pending) items.push(null, ['Delete from this device…', async () => { if (confirm(`Delete "${d.name}" from this device? It was never uploaded.`)) { await local.deleteDoc(d.id); load(); } }]);
  menu(anchor, items);
}

async function fetchContent(d) {
  try {
    return (await api(`/docs/${d.id}/content`));
  } catch (e) {
    const k = await local.getDoc(d.id);
    if (k) return { text: k.local || k.base, seq: k.seq };
    throw e;
  }
}

async function downloadDoc(d) {
  try {
    const { text } = await fetchContent(d);
    local.download(local.fileName(d.name, d.id), text);
  } catch (e) { toast(e.message, 'error'); }
}

async function keep(d) {
  try {
    const { text, seq } = await api(`/docs/${d.id}/content`);
    await local.putDoc({ id: d.id, name: d.name, role: d.role, seq, base: text, local: text, savedAt: Date.now() });
    toast(`"${d.name}" is kept on this device.`, 'ok');
    load();
  } catch (e) { toast(e.message, 'error'); }
}

async function rename(d) {
  const name = await ask('Rename document', d.name, 'Rename');
  if (!name || name === d.name) return;
  try { d.name = (await api(`/docs/${d.id}`, { method: 'PATCH', body: { name } })).name || name; render(); } catch (e) { toast(e.message, 'error'); }
}

async function remove(d) {
  if (!confirm(`Delete "${d.name}" for everyone it's shared with? This can't be undone from Keel.`)) return;
  try {
    await api(`/docs/${d.id}`, { method: 'DELETE' });
    await local.deleteDoc(d.id);
    docs = docs.filter((x) => x !== d);
    render();
  } catch (e) { toast(e.message, 'error'); }
}

async function createDialog() {
  const name = await ask('New document', 'Untitled document', 'Create');
  if (name) createDoc(name);
}

async function createDoc(name, text) {
  try {
    const { document: doc } = await api('/docs', { method: 'POST', body: { name, text } });
    location.href = `/d/${doc.id}`;
  } catch (e) {
    if (e.status !== 0) return toast(e.message, 'error');
    // Offline: make it on this device; it uploads next time Keel opens online.
    const id = `local-${crypto.randomUUID().slice(0, 8)}`;
    const body = text || JSON.stringify({ format: 'solidcraft/57', name, units: 'mm', params: [], features: [], next_id: 1, next_component_color_index: 0 }, null, 2);
    await local.putDoc({ id, name, role: 'owner', seq: 0, base: '', local: body, savedAt: Date.now(), pending: true });
    location.href = `/d/${id}`;
  }
}

async function uploadOfflineDocs() {
  for (const d of await local.allDocs()) {
    if (!d.id.startsWith('local-') || !d.local) continue;
    try {
      const { document: doc } = await api('/docs', { method: 'POST', body: { name: d.name, text: d.local } });
      await local.putDoc({ ...d, id: doc.id, pending: false, seq: 1, base: d.local });
      await local.deleteDoc(d.id);
      toast(`Uploaded "${d.name}", made while offline.`, 'ok');
    } catch (e) {
      if (e.status === 0) return;
      toast(`Couldn't upload "${d.name}": ${e.message}`, 'error');
    }
  }
}

function importFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.onchange = () => input.files[0] && importOne(input.files[0]);
  input.click();
}

/** A file dropped anywhere on the documents page is imported too. */
function wireDrops() {
  if (document.body.dataset.drops) return;
  document.body.dataset.drops = '1';
  const over = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } };
  document.addEventListener('dragover', over);
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    const file = e.dataTransfer?.files?.[0];
    if (!file || !me) return;
    e.preventDefault();
    importOne(file);
  });
}

/** Turn a file into a document: designs open as they are; CAD, meshes, point clouds, drawings
 *  and boards become a new document the editor converts (in this browser) when it opens. */
async function importOne(file) {
  const format = formatOf(file.name);
  if (!format) return toast(`Keel can't read ${file.name}. It imports ${READABLE}, and Keel or SolidCraft designs.`, 'error', 8000);
  if (format.kind === 'closed') return closedFormat(file, format);
  if (format.kind === 'design') {
    const text = await file.text();
    let name = nameFromFile(file.name);
    try { const d = JSON.parse(text); if (typeof d.format !== 'string' || !Array.isArray(d.features)) throw 0; if (name === 'Untitled' && d.name) name = d.name; } catch {
      return toast(`${file.name} isn't a Keel or SolidCraft design (it isn't the JSON they save).`, 'error', 7000);
    }
    return createDoc(name, text);
  }
  if (file.size > 512 * 1024 * 1024) return toast(`${file.name} is over 512 MB, too big to import in the browser.`, 'error');
  let units = null;
  if (format.units) {
    units = await chooseUnits(file.name);
    if (!units) return;
  }
  try {
    const { document: doc } = await api('/docs', { method: 'POST', body: { name: nameFromFile(file.name) } });
    // The editor picks it up from this device's storage and converts it when the modeller is ready.
    await local.setKv(`import:${doc.id}`, { name: file.name, blob: file, units, kind: format.kind, label: format.label, at: Date.now() });
    location.href = `/d/${doc.id}`;
  } catch (e) {
    toast(e.status === 0 ? 'Importing needs a connection the first time: the document is made on the server.' : e.message, 'error');
  }
}

function chooseUnits(fileName) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><div class="head">Units of ${esc(fileName)}</div>
      <div class="content"><p class="meta" style="margin:0 0 10px">STL and OBJ files don't say what unit their numbers are in. Which is it?</p>
      <select aria-label="Units">${UNIT_CHOICES.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</select></div>
      <div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Import</button></div></form>`;
    document.body.append(dlg);
    const select = dlg.querySelector('select');
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? select.value : null); dlg.remove(); });
    dlg.showModal();
  });
}

function closedFormat(file, format) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog"><div class="head">${esc(format.label)} files need exporting first</div>
    <div class="content">
      <p style="margin:0 0 10px">${esc(file.name)} is in ${esc(format.from)}'s own format, which only ${esc(format.from)} (and its maker's services) can read.</p>
      <p style="margin:0 0 10px"><b>${esc(format.how)}</b></p>
      <p class="meta" style="margin:0">STEP keeps exact solids, so the result is a proper CAD model you can keep editing in Keel. Keel imports ${esc(READABLE)}.</p>
    </div>
    <div class="actions"><button class="btn primary" value="ok">OK</button></div></form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ---------------- backup folder ----------------

async function renderBackup() {
  const box = document.getElementById('backup');
  if (!local.folderSupported()) {
    box.innerHTML = '<span>Every design you open is kept on this device. To back up to a folder, use Chrome or Edge.</span>';
    return;
  }
  const handle = await local.getKv('backupFolder');
  const granted = handle && (await local.backupFolder());
  box.innerHTML = handle
    ? `<span>Backing up to folder <b>${esc(handle.name)}</b>${granted ? '' : ' (paused: allow access again)'}</span>
       <button class="btn" id="bk-now">${granted ? 'Back up all now' : 'Allow access'}</button>
       <button class="btn ghost" id="bk-off">Stop backing up</button>`
    : `<span>Keep a copy of every document in a folder on your computer.</span><button class="btn" id="bk-pick">Back up to a folder…</button>`;
  document.getElementById('bk-pick')?.addEventListener('click', async () => {
    try { await local.chooseFolder(); await backupAll(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error'); }
    renderBackup();
  });
  document.getElementById('bk-now')?.addEventListener('click', async () => {
    if (await local.backupFolder({ ask: true })) await backupAll();
    renderBackup();
  });
  document.getElementById('bk-off')?.addEventListener('click', async () => { await local.forgetFolder(); renderBackup(); });
}

async function backupAll() {
  let n = 0;
  for (const d of docs) {
    try {
      const { text } = await fetchContent(d);
      if (await local.writeBackup(d.name, d.id, text)) n++;
    } catch (e) { console.warn('backup', d.id, e); }
  }
  toast(`Backed up ${n} document${n === 1 ? '' : 's'}.`, 'ok');
}

// ---------------- small UI helpers ----------------

// API tokens for agents and scripts, and how to connect them.
async function tokensDialog() {
  const dlg = document.createElement('dialog');
  dlg.style.width = 'min(640px, calc(100% - 32px))';
  document.body.append(dlg);
  const site = location.origin;
  const setup = (token) => `
    <p style="margin:0 0 6px"><b>Claude Code, nothing to install</b> (the remote MCP server):</p>
    <pre class="code">claude mcp add --transport http keel ${esc(site)}/mcp --header "Authorization: Bearer ${esc(token)}"</pre>
    <p class="meta" style="margin:6px 0 0">claude.ai, ChatGPT and other apps with connectors: add <code>${esc(site)}/mcp</code> as a custom connector and sign in when asked. No token needed.</p>
    <p style="margin:10px 0 6px"><b>Or the <code>keel</code> command</b>, which also pulls documents to local <code>.sc</code> files, pushes them back and merges:</p>
    <pre class="code">curl -fsSLO ${esc(site)}/keel.mjs
node keel.mjs login --url ${esc(site)} --token ${esc(token)}
claude mcp add keel -- node "$PWD/keel.mjs" mcp</pre>
    <p class="meta" style="margin:8px 0 0">Or set <code>KEEL_URL</code> and <code>KEEL_TOKEN</code> in the agent's environment. Keep tokens out of files you commit.</p>`;
  async function render(fresh = null) {
    let tokens = [];
    try { tokens = (await api('/tokens')).tokens; } catch (e) { toast(e.message, 'error'); }
    dlg.innerHTML = `<form method="dialog">
      <div class="head">API tokens and agents</div>
      <div class="content">
        <p class="meta" style="margin:0 0 12px">A token lets an agent (Claude Code, Codex, a script) open and edit your documents as you, from your computer. Each change it makes shows up live, labelled with the token's name. Revoke a token here at any time.</p>
        ${fresh ? `<div class="newtoken"><p style="margin:0 0 6px"><b>Copy this token now.</b> It isn't shown again.</p>
          <pre class="code" id="tok">${esc(fresh.token)}</pre><button type="button" class="btn" id="copy">Copy token</button>
          <div style="margin-top:12px">${setup(fresh.token)}</div></div>` : ''}
        <div class="field" style="display:flex;gap:8px;align-items:end;margin-top:12px">
          <div style="flex:1"><label for="tname">New token</label><input type="text" id="tname" placeholder="Claude Code on my laptop" maxlength="80"></div>
          <select id="tscope" style="width:auto"><option value="write">Read and write</option><option value="read">Read only</option></select>
          <select id="tdays" style="width:auto"><option value="0">Never expires</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select>
          <button type="button" class="btn primary" id="make">Create</button>
        </div>
        ${tokens.length ? tokens.filter((t) => !t.document_id).map((t) => `<div class="list-item"><div class="grow"><b>${esc(t.name)}</b> <span class="pill">${t.scope === 'read' ? 'read only' : 'read and write'}</span>
          <div class="meta">…${esc(t.hint)} · made ${when(t.created_at)} · ${t.last_used_at ? `last used ${when(t.last_used_at)}` : 'never used'}${t.expires_at ? ` · expires ${new Date(t.expires_at).toLocaleDateString()}` : ''}</div></div>
          <button type="button" class="btn danger" data-revoke="${esc(t.id)}">Revoke</button></div>`).join('') : '<p class="meta">No tokens yet.</p>'}
        ${fresh ? '' : `<details style="margin-top:12px"><summary>How agents connect</summary>${setup('keel_YOUR_TOKEN')}</details>`}
        <p class="meta" style="margin:12px 0 0">Agents without an account can still make <b>loose documents</b>: no sign-in, reached by a key, and deleted a set number of days after they're made. See <a href="/agents.md" target="_blank">/agents.md</a>.</p>
      </div>
      <div class="actions"><button class="btn" value="close">Done</button></div></form>`;
    dlg.querySelector('#make').onclick = async () => {
      const name = dlg.querySelector('#tname').value.trim();
      if (!name) return dlg.querySelector('#tname').focus();
      try {
        const { token } = await api('/tokens', { method: 'POST', body: { name, scope: dlg.querySelector('#tscope').value, days: Number(dlg.querySelector('#tdays').value) } });
        render(token);
      } catch (e) { toast(e.message, 'error'); }
    };
    dlg.querySelector('#tname').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.querySelector('#make').click(); } };
    const copy = dlg.querySelector('#copy');
    if (copy) copy.onclick = async () => { await navigator.clipboard.writeText(fresh.token).catch(() => {}); copy.textContent = 'Copied'; };
    for (const b of dlg.querySelectorAll('[data-revoke]')) {
      b.onclick = async () => {
        if (!confirm('Revoke this token? Agents using it stop working at once.')) return;
        try { await api(`/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'error'); }
      };
    }
  }
  dlg.addEventListener('close', () => dlg.remove());
  await render();
  dlg.showModal();
}

function ask(title, value, action) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><div class="head">${esc(title)}</div><div class="content"><input type="text" value="${esc(value)}" aria-label="${esc(title)}"></div>
      <div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">${esc(action)}</button></div></form>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    // Enter confirms (the form's first button is Cancel, which Enter would otherwise press).
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } });
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? input.value.trim() : null); dlg.remove(); });
    dlg.showModal();
    input.select();
  });
}

export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  for (const it of items) {
    if (!it) { m.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = it[0];
    if (!it[1]) { b.disabled = true; b.style.color = 'var(--muted)'; } else b.onclick = () => { m.remove(); it[1](); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}
