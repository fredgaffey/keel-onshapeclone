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

import { api, esc, when, toast, initials, registerServiceWorker, useKey } from './api.js';
import * as local from './local.js';
import { mergeDesigns } from './merge.js';

const docId = location.pathname.split('/')[2];
const isLocalOnly = docId.startsWith('local-');
// A loose document (no account) is opened with its key in the address's #fragment, which never
// reaches the server's logs. It's remembered on this device so the document reopens without it.
const docKey = (() => {
  const fromHash = /(?:^#|&)key=(keel_[A-Za-z0-9]+)/.exec(location.hash)?.[1];
  try {
    if (fromHash) localStorage.setItem(`keel-key:${docId}`, fromHash);
    return fromHash || localStorage.getItem(`keel-key:${docId}`);
  } catch { return fromHash || null; }
})();
if (docKey) useKey(docKey);
// Agent host: this tab runs SolidCraft commands, inspections and screenshots for agents (relayed by
// the document's room). On by default in a tab that can edit; ?host=1 marks a tab opened only for
// agents (`keel host`), which agents prefer.
const dedicatedHost = new URLSearchParams(location.search).get('host') === '1';
const hostAllowed = () => { try { return dedicatedHost || localStorage.getItem('keel-agent-host') !== 'off'; } catch { return true; } };
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
window.keelSync = S; // for tests and debugging


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
    S.expires = d.expires_at || null;
    S.me = (await api('/me')).user;
  } catch (e) {
    if (e.status === 401 && docKey) {
      $('loading-text').textContent = `${e.message} Loose documents are deleted a set number of days after they're made.`;
      $('loading').querySelector('.spinner')?.remove();
      return;
    }
    if (e.status === 401) return location.replace('/');
    if (e.status === 404 && !isLocalOnly) return deadEnd(e.message);
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
  // A viewer's own changes are never saved: put the document back as it is, rather than leave
  // them looking at a model nobody else has.
  if (S.role === 'view' && S.base !== null && S.known !== S.base && !(await busyEditing())) {
    await load(S.base);
    toast('View only: your change was undone. Ask the owner for edit access to change this document.', 'info', 6000);
  }
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
  try {
    await reconcileInner(theirs, seq, by);
    if (S.importError && S.seq >= S.importError.seq) S.importError = null;
  } catch (e) {
    // The newer design doesn't open here (a hand-written or agent-made design the modeller
    // refuses). Keep what we have, say so, and let an agent waiting on this version know.
    S.importError = { seq, by, message: e.message };
    banner(`${by || 'Someone'}'s latest change (version ${seq}) couldn't be opened: ${e.message}. You're still on version ${S.seq}; Versions can restore an earlier one.`);
    throw e;
  }
}

async function reconcileInner(theirs, seq, by) {
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
  const ws = new WebSocket(`${proto}://${location.host}/api/docs/${docId}/ws${docKey ? `?key=${encodeURIComponent(docKey)}` : ''}`);
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
    if (ev.code === 4410) {
      banner('This loose document has been deleted (it reached its deletion date).');
      return;
    }
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
// Back online with the modeller never loaded (it wasn't on this device yet): start again now.
window.addEventListener('online', () => { if (!S.cad && $('loading') && !$('loading').hidden) location.reload(); });

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
      send({ type: 'host', on: hostAllowed(), dedicated: dedicatedHost });
      if (dedicatedHost) banner('This tab is working for agents: they inspect, screenshot and model here. Keep it open (and visible) while they work.');
      else if (S.role === 'view') banner('View only: you can look around and measure, but changes aren\'t saved.');
      else if (S.expires) banner(`Loose document, with no account: it will be deleted on ${new Date(S.expires).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}. Anyone with this page's address can edit it. Download it to keep a copy.`);
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
    case 'renamed':
      S.name = msg.name;
      if (document.activeElement !== $('docname')) $('docname').value = msg.name;
      document.title = `${msg.name} · Keel`;
      persistSoon();
      break;
    case 'run':
      runForAgent(msg); // not awaited: it may wait for remote changes queued behind this message
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
  const who = (p) => (p.agent ? p.conn : p.id); // an agent shares its person's id but shows apart
  const others = S.peers.filter((p, i, all) => all.findIndex((q) => who(q) === who(p)) === i);
  $('peers').innerHTML = others.map((p) => `<span class="avatar" style="background:${esc(p.color)}" title="${esc(p.name)}${p.agent ? ' (agent)' : p.id === S.me?.id ? ' (you)' : ''}${p.role === 'view' ? ' · viewing' : ''}${p.activity ? ` · ${esc(p.activity)}` : ''}">${esc(initials(p.name))}</span>`).join('');
}

// ---------------- agent host ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run an agent's calls here (see DocRoom /run), then report back, once any change is saved. */
async function runForAgent(msg) {
  const deadline = Date.now() + Math.max(5_000, (msg.timeout_ms || 60_000) - 3_000);
  const reply = (r) => send({ type: 'ran', rid: msg.rid, ...r });
  if (!hostAllowed()) return reply({ ok: false, error: 'Agents are turned off in that tab.' });
  // Catch up first: an agent that just wrote wants its check to see that write.
  const refused = () => S.importError && S.importError.seq >= msg.at_seq;
  while (msg.at_seq && (S.seq < msg.at_seq || S.pendingRemote) && !refused() && Date.now() < deadline) {
    if (S.pendingRemote && !S.inflight) await serial(async () => { if (S.pendingRemote) { const m = S.pendingRemote; S.pendingRemote = null; await reconcile(m.text, m.seq, m.by); } });
    await sleep(100);
  }
  if (msg.at_seq && refused()) return reply({ ok: false, opens: false, seq: S.importError.seq, error: `Version ${S.importError.seq} doesn't open in the modeller: ${S.importError.message}` });
  if (msg.at_seq && S.seq < msg.at_seq) return reply({ ok: false, error: `This tab hasn't received version ${msg.at_seq} yet (it has ${S.seq}).` });
  flashAgent(msg.by);
  const out = await serial(async () => {
    const results = [];
    for (const [i, c] of msg.calls.entries()) {
      try {
        const left = deadline - Date.now();
        if (left < 1000) throw new Error('out of time');
        const call = c.method === 'keel.screenshot' ? screenshot(c.params || {}) : S.cad.request(c.method, c.params ?? {});
        results.push(await Promise.race([call, sleep(left).then(() => { throw new Error(`${c.method} didn't finish in time`); })]));
      } catch (e) {
        return { ok: false, results, failed: { index: i, method: c.method, error: e.message } };
      }
    }
    await readEngine();
    return { ok: true, results };
  });
  // A change: wait until the room has it, so the agent's next read sees it.
  while ((S.known !== S.base || S.inflight) && S.connected && Date.now() < deadline) await sleep(100);
  reply({ ...(out || { ok: false, error: 'The tab could not run that.' }), seq: S.seq, saved: S.known === S.base });
}

/** The 3D view as a JPEG, at most `max` pixels wide (agents pay for pixels): a named view is
 *  framed to fit, and the picture is cropped to the viewport (no ribbon or panels) unless `chrome`. */
async function screenshot({ view, max = 1024, quality = 0.82, chrome = false } = {}) {
  if (view) {
    await S.cad.request('ui.view', { view });
    if (view !== 'fit') await S.cad.request('ui.view', { view: 'fit' });
  }
  const w = $('cad').contentWindow;
  const canvas = w.document.querySelector('canvas');
  if (!canvas) throw new Error('no viewport yet');
  const rect = chrome ? null : viewportRect(await S.cad.request('ui.inspect').catch(() => null), canvas);
  const stream = canvas.captureStream(30);
  const video = document.createElement('video');
  const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`the screenshot timed out (${what})`); })]);
  try {
    video.muted = true;
    video.srcObject = stream;
    // The modeller only draws when something changes, and a stream only has frames when it
    // draws: nudge it with a pointer move over the canvas so there is a frame to take.
    const nudge = () => {
      const b = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new w.PointerEvent('pointermove', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, pointerType: 'mouse' }));
    };
    nudge();
    await within(video.play(), 4000, 'no picture');
    const nudger = setInterval(nudge, 150);
    try {
      await within(new Promise((r) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(r) : setTimeout(r, 300))), 4000, 'no frame drawn');
    } finally { clearInterval(nudger); }
    const [sx, sy, sw, sh] = rect || [0, 0, video.videoWidth, video.videoHeight];
    const scale = Math.min(1, max / sw);
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', quality);
    return { image: data.slice(data.indexOf(',') + 1), mime: 'image/jpeg', width: c.width, height: c.height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

/** The 3D viewport inside the app, in the canvas's pixels: [x, y, w, h], or null. */
function viewportRect(ui, canvas) {
  const v = ui && (ui.viewport_rect || ui.viewport?.rect || ui.viewport);
  let r = null;
  if (Array.isArray(v) && v.length === 4) r = v;
  else if (v && Array.isArray(v.min) && Array.isArray(v.max)) r = [v.min[0], v.min[1], v.max[0] - v.min[0], v.max[1] - v.min[1]];
  else if (v && ['x', 'y', 'w', 'h'].every((k) => typeof v[k] === 'number')) r = [v.x, v.y, v.w, v.h];
  else if (v && ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number')) r = [v.x, v.y, v.width, v.height];
  if (!r || !(r[2] > 10 && r[3] > 10)) return null;
  const k = canvas.width / (canvas.clientWidth || canvas.width); // UI points to canvas pixels
  const px = r.map((n) => Math.round(n * k));
  return px[0] + px[2] <= canvas.width + 2 && px[1] + px[3] <= canvas.height + 2 ? px : null;
}

let flashTimer = null;
function flashAgent(by) {
  const el = $('agentnote');
  if (!el || dedicatedHost) return;
  el.textContent = `${by || 'An agent'} is working in this tab`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 4000);
}

/** The top bar's switch: may agents use this tab? */
export function setAgentHost(on) {
  try { localStorage.setItem('keel-agent-host', on ? 'on' : 'off'); } catch {}
  send({ type: 'host', on, dedicated: dedicatedHost });
}

/** The document can't be opened here (deleted, or not shared): say so plainly, with a way out. */
function deadEnd(message) {
  for (const b of document.querySelectorAll('.bar .btn, #status, #agentnote')) b.hidden = true;
  $('cad').hidden = true;
  $('loading').innerHTML = `<div class="box"><p style="font-size:16px;margin:0 0 10px">${esc(message)}</p><a class="btn primary" href="/">All documents</a></div>`;
  $('loading').hidden = false;
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
      const r = await api(`/docs/${docId}`, { method: 'PATCH', body: { name } });
      S.name = r.name || name; // as the server kept it (it trims and shortens names)
      nameInput.value = S.name;
      document.title = `${S.name} · Keel`;
    } catch (e) { toast(e.message, 'error'); nameInput.value = S.name; }
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = S.name; nameInput.blur(); } });
  nameInput.addEventListener('blur', commit);
  $('share-btn').onclick = shareDrawer;
  const agentsBtn = $('agents-btn');
  const showAgents = () => { agentsBtn.textContent = hostAllowed() ? 'Agents: on' : 'Agents: off'; };
  showAgents();
  agentsBtn.onclick = () => {
    const on = !hostAllowed();
    setAgentHost(on);
    showAgents();
    toast(on ? 'Agents can now inspect, screenshot and model in this tab. Set them up from your name → API tokens and agents on the home page.' : 'Agents can no longer use this tab. They can still read and edit the document itself.', 'info', 6000);
  };
  $('versions-btn').onclick = versionsDrawer;
  // Flexblade: a panel talking to a local `flexblade gui` server (pull STEP, push parameters).
  // Loaded on first click; its engine work goes through `serial` like ours.
  $('flexblade-btn').hidden = S.role === 'view';
  $('flexblade-btn').onclick = async () => {
    if (!S.cad) return toast('The modeller is still loading', 'error');
    if (S.flexblade) return S.flexblade.toggle();
    const { install } = await import('./flexblade.js');
    S.flexblade = install({ app: S.cad, frame: $('cad'), run: serial });
  };
  // Scripts: Keel's default parametric generators; each runs as SolidCraft commands through `serial`.
  $('scripts-btn').hidden = S.role === 'view';
  $('scripts-btn').onclick = async () => {
    if (!S.cad) return toast('The modeller is still loading', 'error');
    if (S.scripts) return S.scripts.toggle();
    const { install } = await import('./scripts-panel.js');
    S.scripts = install({ app: S.cad, frame: $('cad'), run: serial });
  };
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
