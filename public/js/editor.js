// The document editor: SolidCraft in a same-origin frame (`?embed=editor`), driven through its
// browser API (`frame.contentWindow.solidcraft`), kept in sync with the document's room on the
// server and with a copy on this device.
//
// Sync, in short: every few hundred milliseconds we ask SolidCraft for its design revision; when
// it moves we export the design. If it differs from the last text the server confirmed (`base`)
// we send it with base's sequence number. The server acks it, or answers "stale" with the newer
// design, which we merge our change onto (merge.js) and send again. Other people's accepted
// changes arrive as "remote" and are loaded into SolidCraft (merged with anything we haven't
// sent yet). The design is also written to IndexedDB after every change, so closing the tab,
// losing the connection or working on a plane loses nothing: it is sent when we're back.

import { api, esc, when, toast, initials, registerServiceWorker } from './api.js';
import * as local from './local.js';
import { mergeDesigns } from './merge.js';

const docId = location.pathname.split('/')[2];
const isLocalOnly = docId.startsWith('local-');
const $ = (id) => document.getElementById(id);

const S = {
  name: '',
  role: 'edit',
  me: null,
  cad: null, // window.solidcraft of the frame
  seq: 0, // server sequence number of `base`
  base: null, // the design as the server last confirmed it
  known: null, // the design as SolidCraft has it now (as far as we've seen)
  engineRev: null, // SolidCraft's revision when we last read or wrote `known`
  inflight: null, // {id, text} sent, awaiting ack/stale
  ws: null,
  connected: false,
  everConnected: false,
  pendingRemote: null,
  lastInput: 0,
  pointerDown: false,
  peers: [],
  retry: 0,
  version: 0,
};

let chain = Promise.resolve();
/** Run engine work one piece at a time: imports and exports must never interleave. */
const serial = (fn) => (chain = chain.then(fn, fn).catch((e) => console.error(e)));

registerServiceWorker();
boot().catch((e) => {
  console.error(e);
  $('loading-text').textContent = `Couldn't open this document: ${e.message}`;
});

async function boot() {
  const kept = await local.getDoc(docId);
  try {
    const { document: d } = await api(`/docs/${docId}`);
    S.name = d.name;
    S.role = d.role === 'view' ? 'view' : 'edit';
    S.me = (await api('/me')).user;
  } catch (e) {
    if (e.status === 401) return location.replace('/');
    if (e.status === 404 && !isLocalOnly) {
      $('loading-text').textContent = e.message;
      $('loading').querySelector('.spinner').remove();
      return;
    }
    if (!kept) throw new Error('you\'re offline and this document isn\'t on this device');
    S.name = kept.name;
    S.role = kept.role === 'view' ? 'view' : 'edit';
    S.me = await local.getKv('me');
  }
  document.title = `${S.name} · Keel`;
  $('docname').value = S.name;
  $('docname').readOnly = S.role === 'view';
  wireBar();

  S.cad = await loadCad();
  if (kept && (kept.local || kept.base)) {
    // Open the copy on this device straight away; the server's version is merged in when we connect.
    await serial(async () => {
      await load(kept.local || kept.base);
      S.base = kept.base || null;
      S.seq = kept.seq || 0;
      if (kept.local && kept.local !== kept.base) S.known = kept.local;
    });
    hideLoading();
  }
  if (isLocalOnly) {
    banner('Made while offline: this document is only on this device until you\'re back online.');
    window.addEventListener('online', uploadLocalOnly);
    uploadLocalOnly();
  } else {
    connect();
  }
  setInterval(() => serial(tick), 350);
  window.addEventListener('beforeunload', (e) => {
    if (S.known !== S.base && !isLocalOnly && S.role === 'edit') {
      persist(); // the copy on this device has it; it's sent next time
      if (!S.connected) return;
      e.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', () => document.hidden && persist());
}

// ---------------- SolidCraft frame ----------------

function loadCad() {
  const frame = $('cad');
  const params = new URLSearchParams({ embed: 'editor' });
  if (!('gpu' in navigator)) params.set('webgl', '');
  frame.src = `/cad/index.html?${params}`.replace('webgl=', 'webgl');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let retried = false;
    const wait = setInterval(async () => {
      let app = null;
      try { app = frame.contentWindow && frame.contentWindow.solidcraft; } catch { /* an error page: not ours */ }
      if (app) {
        clearInterval(wait);
        try {
          await app.request('document.revision');
          watchInput(frame);
          resolve(app);
        } catch (e) { reject(e); }
      } else if (!retried && Date.now() - started > 60_000) {
        // A download cut off part-way leaves the frame dead: one more try.
        retried = true;
        frame.src = `${frame.src}&retry=1`;
      } else if (Date.now() - started > 180_000) {
        clearInterval(wait);
        reject(new Error(navigator.onLine ? 'the modeller didn\'t start (it needs WebGPU or WebGL2)' : 'the modeller isn\'t on this device yet: open Keel once online and leave it a minute to finish downloading'));
      }
    }, 200);
  });
}

function watchInput(frame) {
  const w = frame.contentWindow;
  const mark = () => (S.lastInput = Date.now());
  w.addEventListener('pointerdown', () => { S.pointerDown = true; mark(); }, true);
  w.addEventListener('pointerup', () => { S.pointerDown = false; mark(); }, true);
  w.addEventListener('keydown', mark, true);
}

/** Put `text` into SolidCraft and record what it now holds. */
async function load(text) {
  const r = await S.cad.request('document.import', { text, name: S.name });
  const exp = await S.cad.request('document.export');
  S.engineRev = exp.revision;
  S.known = exp.text;
  return r;
}

function hideLoading() {
  $('loading').hidden = true;
}

/** Someone is mid-gesture or has a dialog open: loading a new design now would cut them off. */
async function busyEditing() {
  if (S.pointerDown || Date.now() - S.lastInput < 1200) return true;
  try {
    const ui = await S.cad.request('ui.inspect');
    return !!(ui && ui.dialog);
  } catch { return false; }
}

// ---------------- sync ----------------

async function tick() {
  if (!S.cad || S.known === null && S.base === null) return;
  if (S.pendingRemote && !(await busyEditing())) {
    const m = S.pendingRemote;
    S.pendingRemote = null;
    await reconcile(m.text, m.seq, m.by);
  }
  await readEngine();
  if (S.role === 'edit' && S.connected && !S.inflight && S.base !== null && S.known !== S.base && !isLocalOnly) {
    const id = ++S.version;
    S.inflight = { id, text: S.known };
    send({ type: 'update', id, base: S.seq, text: S.known });
  }
  status();
}

async function readEngine() {
  const r = await S.cad.request('document.revision');
  if (r.revision === S.engineRev) return;
  const exp = await S.cad.request('document.export');
  S.engineRev = exp.revision;
  if (exp.text !== S.known) {
    S.known = exp.text;
    persistSoon();
    presence('editing');
  }
}

/** The server's design is now `theirs` (at `seq`): bring SolidCraft and our copy up to it. */
async function reconcile(theirs, seq, by) {
  await readEngine();
  const before = S.known;
  const mine = S.known;
  const hadLocal = S.base !== null ? mine !== S.base : mine !== null && mine !== theirs;
  if (!hadLocal || S.role === 'view') {
    if (theirs !== mine) await load(theirs);
    S.base = S.known; // SolidCraft's own spelling of the server's design
  } else {
    const base = S.base ?? theirs;
    const merged = mergeDesigns(base, mine, theirs);
    let r = await load(merged.text);
    if (r.errors > 0 && merged.changed) {
      // The merge doesn't rebuild cleanly. Take theirs, and keep ours as a separate copy.
      const fallback = await load(theirs);
      if (fallback.errors < r.errors) {
        await keepConflictCopy(mine);
        r = fallback;
      } else {
        await load(merged.text);
      }
    }
    S.base = theirs;
    if (merged.conflicts.length) toast(`Merged with ${by || 'someone'}'s changes. ${merged.conflicts.length} conflict${merged.conflicts.length > 1 ? 's' : ''}: ${merged.conflicts[0]}`, 'info', 7000);
  }
  S.seq = seq;
  if (S.known === S.base) await S.cad.request('document.saved', { revision: S.engineRev }).catch(() => {});
  if (by && before !== null && before !== S.known) toast(`${by}: ${describeChange(before, S.known)}`);
  persist();
}

async function keepConflictCopy(text) {
  try {
    const { document: d } = await api('/docs', { method: 'POST', body: { name: `${S.name} (conflicted copy)`, text } });
    toast(`Your change clashed with someone else's. It's kept as "${S.name} (conflicted copy)".`, 'info', 9000);
    return d;
  } catch {
    local.download(local.fileName(`${S.name} (conflicted copy)`, docId), text);
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/docs/${docId}/ws`);
  S.ws = ws;
  let pinger;
  ws.onopen = () => {
    S.retry = 0;
    pinger = setInterval(() => send({ type: 'ping' }), 25_000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    serial(() => onMessage(msg));
  };
  ws.onclose = (ev) => {
    clearInterval(pinger);
    S.connected = false;
    S.inflight = null;
    S.peers = [];
    renderPeers();
    status();
    if (ev.code === 4403) {
      banner('Your access to this document was changed. Reloading…');
      setTimeout(() => location.reload(), 1500);
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** S.retry++);
    setTimeout(() => (navigator.onLine ? connect() : window.addEventListener('online', connect, { once: true })), delay);
  };
}

// The browser knows the network went away before the socket does.
window.addEventListener('offline', () => S.ws && S.ws.close());

function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
}

async function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': {
      S.connected = true;
      S.everConnected = true;
      S.role = msg.you.role === 'view' ? 'view' : 'edit';
      S.peers = msg.peers;
      renderPeers();
      if (S.base === null && S.known === null) {
        await load(msg.text);
        S.base = S.known;
        S.seq = msg.seq;
        persist();
      } else if (msg.seq !== S.seq || S.known !== S.base) {
        await reconcile(msg.text, msg.seq, null);
      }
      hideLoading();
      if (S.role === 'view') banner('View only: you can look around and measure, but changes aren\'t saved.');
      break;
    }
    case 'remote':
      if (S.inflight) break; // our update will come back "stale" with this design in it
      if (await busyEditing()) S.pendingRemote = msg;
      else await reconcile(msg.text, msg.seq, msg.by);
      break;
    case 'ack':
      if (!S.inflight || S.inflight.id !== msg.id) break;
      S.base = S.inflight.text;
      S.seq = msg.seq;
      S.inflight = null;
      if (S.known === S.base) await S.cad.request('document.saved', { revision: S.engineRev }).catch(() => {});
      persist();
      backupSoon();
      break;
    case 'stale':
      S.inflight = null;
      await reconcile(msg.text, msg.seq, msg.by);
      break;
    case 'error':
      S.inflight = null;
      toast(msg.message, 'error');
      break;
    case 'peers':
      S.peers = msg.peers;
      renderPeers();
      break;
  }
  status();
}

let presenceTimer = null;
let lastPresence = null;
function presence(activity) {
  if (activity !== lastPresence) send({ type: 'presence', activity });
  lastPresence = activity;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => { lastPresence = null; send({ type: 'presence', activity: null }); }, 4000);
}

// ---------------- this device ----------------

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}
function persist() {
  clearTimeout(persistTimer);
  if (S.known === null && S.base === null) return;
  return local.putDoc({ id: docId, name: S.name, role: S.role, seq: S.seq, base: S.base, local: S.known, savedAt: Date.now(), pending: isLocalOnly });
}

let backupTimer = null;
function backupSoon() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => local.writeBackup(S.name, docId, S.base).catch((e) => console.warn('backup', e)), 2000);
}

async function uploadLocalOnly() {
  if (!navigator.onLine) return;
  await serial(readEngine);
  try {
    const { document: d } = await api('/docs', { method: 'POST', body: { name: S.name, text: S.known } });
    await local.putDoc({ id: d.id, name: S.name, role: 'owner', seq: 1, base: S.known, local: S.known, savedAt: Date.now() });
    await local.deleteDoc(docId);
    location.replace(`/d/${d.id}`);
  } catch (e) {
    if (e.status !== 0) toast(`Couldn't upload: ${e.message}`, 'error');
  }
}

// ---------------- the bar ----------------

function status() {
  const dot = $('status').querySelector('.dot');
  let text, cls;
  if (isLocalOnly) [text, cls] = ['On this device only', 'busy'];
  else if (!S.connected) [text, cls] = [S.known !== S.base ? 'Offline: changes kept on this device' : (S.everConnected || !navigator.onLine ? 'Offline: working on this device' : 'Connecting…'), 'off'];
  else if (S.role === 'view') [text, cls] = ['View only', 'ok'];
  else if (S.inflight || S.known !== S.base || S.pendingRemote) [text, cls] = ['Saving…', 'busy'];
  else [text, cls] = ['All changes saved', 'ok'];
  dot.className = `dot ${cls}`;
  $('status-text').textContent = text;
}

function renderPeers() {
  const others = S.peers.filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
  $('peers').innerHTML = others.map((p) => `<span class="avatar" style="background:${esc(p.color)}" title="${esc(p.name)}${p.id === S.me?.id ? ' (you)' : ''}${p.role === 'view' ? ' · viewing' : ''}${p.activity ? ` · ${esc(p.activity)}` : ''}">${esc(initials(p.name))}</span>`).join('');
}

function banner(text) {
  $('banner').innerHTML = `<div class="banner">${esc(text)}</div>`;
}

function describeChange(before, after) {
  try {
    const a = JSON.parse(before).features || [];
    const b = JSON.parse(after).features || [];
    const A = new Map(a.map((f) => [f.id, f]));
    const B = new Map(b.map((f) => [f.id, f]));
    const added = b.filter((f) => !A.has(f.id)).map((f) => f.name);
    const removed = a.filter((f) => !B.has(f.id)).map((f) => f.name);
    const changed = b.filter((f) => A.has(f.id) && JSON.stringify(A.get(f.id)) !== JSON.stringify(f)).map((f) => f.name);
    const parts = [];
    if (added.length) parts.push(`added ${added.join(', ')}`);
    if (removed.length) parts.push(`deleted ${removed.join(', ')}`);
    if (changed.length) parts.push(`edited ${changed.join(', ')}`);
    return parts.join('; ') || 'changed the design';
  } catch { return 'changed the design'; }
}

function wireBar() {
  const nameInput = $('docname');
  const commit = async () => {
    const name = nameInput.value.trim();
    if (!name || name === S.name) { nameInput.value = S.name; return; }
    try {
      await api(`/docs/${docId}`, { method: 'PATCH', body: { name } });
      S.name = name;
      document.title = `${name} · Keel`;
    } catch (e) { toast(e.message, 'error'); nameInput.value = S.name; }
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = S.name; nameInput.blur(); } });
  nameInput.addEventListener('blur', commit);
  $('share-btn').onclick = shareDrawer;
  $('versions-btn').onclick = versionsDrawer;
  $('download-btn').onclick = () => serial(async () => {
    await readEngine();
    local.download(local.fileName(S.name, docId), S.known);
  });
}

function drawer(title, html) {
  document.querySelector('.drawer')?.remove();
  const d = document.createElement('aside');
  d.className = 'drawer';
  d.innerHTML = `<header><h3>${esc(title)}</h3><button class="btn ghost" aria-label="Close">✕</button></header><div class="body">${html}</div>`;
  d.querySelector('header button').onclick = () => d.remove();
  document.body.append(d);
  return d.querySelector('.body');
}

async function shareDrawer() {
  const body = drawer('Share', '<p style="color:var(--muted)">Loading…</p>');
  try {
    const { owner, shares } = await api(`/docs/${docId}/shares`);
    const isOwner = owner.id === S.me?.id;
    body.innerHTML = `
      ${isOwner ? `<form id="share-form" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
        <input type="email" id="share-email" placeholder="Email of a Keel user" required aria-label="Email">
        <div style="display:flex;gap:8px"><select id="share-role" aria-label="Access"><option value="edit">Can edit</option><option value="view">Can view</option></select>
        <button class="btn primary">Share</button></div></form>` : '<p style="color:var(--muted)">Only the owner can change who has access.</p>'}
      <div class="list-item"><span class="avatar" style="background:#4f5d75">${esc(initials(owner.name))}</span><div class="grow">${esc(owner.name)}<div class="meta">${esc(owner.email)}</div></div><span class="pill">Owner</span></div>
      ${shares.map((s) => `<div class="list-item"><span class="avatar" style="background:#2e86ab">${esc(initials(s.name))}</span><div class="grow">${esc(s.name)}<div class="meta">${esc(s.email)}</div></div>
        <span class="pill">${s.role === 'edit' ? 'Can edit' : 'Can view'}</span>${isOwner ? `<button class="btn ghost" data-remove="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">✕</button>` : ''}</div>`).join('')}
      <p style="color:var(--muted);font-size:12px;margin-top:14px">People you share with need a Keel account on this server.</p>`;
    body.querySelector('#share-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/docs/${docId}/shares`, { method: 'POST', body: { email: body.querySelector('#share-email').value, role: body.querySelector('#share-role').value } });
        shareDrawer();
      } catch (x) { toast(x.message, 'error'); }
    });
    body.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => {
      await api(`/docs/${docId}/shares/${b.dataset.remove}`, { method: 'DELETE' }).catch((x) => toast(x.message, 'error'));
      shareDrawer();
    }));
  } catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function versionsDrawer() {
  const body = drawer('Versions', '<p style="color:var(--muted)">Loading…</p>');
  try {
    const { versions } = await api(`/docs/${docId}/versions`);
    body.innerHTML = `
      ${S.role === 'edit' ? '<form id="ver-form" style="display:flex;gap:8px;margin-bottom:14px"><input type="text" id="ver-name" placeholder="Name this version" aria-label="Version name" required><button class="btn primary">Save</button></form>' : ''}
      ${versions.length ? '' : '<p style="color:var(--muted)">No versions yet. A version keeps the design as it is now, to go back to later.</p>'}
      ${versions.map((v) => `<div class="list-item"><div class="grow">${esc(v.name)}${v.auto ? ' <span class="pill">auto</span>' : ''}<div class="meta">${esc(when(v.created_at))}${v.created_by ? ` · ${esc(v.created_by)}` : ''}</div></div>
        <button class="btn ghost" data-dl="${esc(v.id)}" title="Download">↓</button>${S.role === 'edit' ? `<button class="btn" data-restore="${esc(v.id)}">Restore</button>` : ''}</div>`).join('')}`;
    body.querySelector('#ver-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await serial(tick); // make sure the server has what's on screen
      try {
        await api(`/docs/${docId}/versions`, { method: 'POST', body: { name: body.querySelector('#ver-name').value } });
        toast('Version saved.', 'ok');
        versionsDrawer();
      } catch (x) { toast(x.message, 'error'); }
    });
    body.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => {
      const v = await api(`/docs/${docId}/versions/${b.dataset.dl}`);
      local.download(local.fileName(`${S.name} - ${v.name}`, docId), v.text);
    }));
    body.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Restore this version for everyone? The current design is saved as a version first.')) return;
      try {
        await api(`/docs/${docId}/versions`, { method: 'POST', body: { name: 'Before restore' } });
        await api(`/docs/${docId}/versions/${b.dataset.restore}/restore`, { method: 'POST', body: {} });
        toast('Restored.', 'ok');
        versionsDrawer();
      } catch (x) { toast(x.message, 'error'); }
    }));
  } catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
