import { api, esc, when, toast, initials, registerServiceWorker } from './api.js';
import * as local from './local.js';

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
  document.getElementById('usermenu').onclick = (e) => menu(e.currentTarget, [
    [`Signed in as ${me.email}`, null],
    ['Sign out', async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); location.reload(); }],
  ]);
  root.innerHTML = `
    <div class="home">
      <nav class="side">
        <button class="btn primary create" id="create">+ Create</button>
        <button class="btn" id="import" style="justify-content:center">Import design file…</button>
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
    list.innerHTML = `<div class="empty">${query ? 'No documents match.' : view === 'shared' ? 'Nothing has been shared with you yet.' : 'No documents yet. Create one to start designing.'}</div>`;
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
  try { await api(`/docs/${d.id}`, { method: 'PATCH', body: { name } }); d.name = name; render(); } catch (e) { toast(e.message, 'error'); }
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
  input.accept = '.sc,.solidcraft,.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    let name = file.name.replace(/\.(sc|solidcraft|json)$/i, '').replace(/ \([A-Za-z0-9-]+\)$/, '');
    try { name = JSON.parse(text).name && name === 'Untitled' ? JSON.parse(text).name : name; } catch {
      return toast('That file isn\'t a SolidCraft design. To bring in STEP or STL, open a document and use its Insert commands.', 'error', 7000);
    }
    createDoc(name, text);
  };
  input.click();
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

function ask(title, value, action) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><div class="head">${esc(title)}</div><div class="content"><input type="text" value="${esc(value)}" aria-label="${esc(title)}"></div>
      <div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">${esc(action)}</button></div></form>`;
    document.body.append(dlg);
    const input = dlg.querySelector('input');
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
