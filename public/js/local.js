// What Keel keeps on this device: a copy of every design you open (so it works offline and
// nothing is lost if the connection drops), the document list, and an optional folder on your
// disk that each saved design is also written to.

const DB_NAME = 'keel';
const DB_VERSION = 1;

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

/** A design kept on this device: {id, name, role, seq, base, local, savedAt, owner} */
export const getDoc = (id) => tx('docs', 'readonly', (s) => s.get(id));
export const putDoc = (doc) => tx('docs', 'readwrite', (s) => s.put({ ...doc, keptAt: Date.now() }));
export const deleteDoc = (id) => tx('docs', 'readwrite', (s) => s.delete(id));
export const allDocs = () => tx('docs', 'readonly', (s) => s.getAll());
export const getKv = (key) => tx('kv', 'readonly', (s) => s.get(key));
export const setKv = (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key));

export async function updateDoc(id, patch) {
  const doc = (await getDoc(id)) || { id };
  const next = { ...doc, ...patch };
  await putDoc(next);
  return next;
}

// ---- Backup folder (File System Access API: Chrome, Edge, Opera) ----

export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'keel-backup', mode: 'readwrite' });
  await setKv('backupFolder', handle);
  return handle;
}

export async function forgetFolder() {
  await setKv('backupFolder', undefined);
}

/** The backup folder, if one is set and the browser still lets us write to it without asking. */
export async function backupFolder({ ask = false } = {}) {
  const handle = await getKv('backupFolder');
  if (!handle) return null;
  let state = await handle.queryPermission({ mode: 'readwrite' });
  if (state === 'prompt' && ask) state = await handle.requestPermission({ mode: 'readwrite' });
  return state === 'granted' ? handle : null;
}

export function fileName(name, id) {
  const safe = String(name || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Untitled';
  return `${safe} (${id}).sc`;
}

export async function writeBackup(name, id, text) {
  const folder = await backupFolder();
  if (!folder) return false;
  const file = await folder.getFileHandle(fileName(name, id), { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
  return true;
}

export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
