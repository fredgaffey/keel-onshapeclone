// Delta patches between SolidCraft WebAssembly builds, so an update downloads what changed instead
// of the whole module (~32 MB compressed, 174 MB raw). Browsers can't do this themselves: HTTP
// compression dictionaries are capped at 100 MiB in Chrome.
//
//   node scripts/cad-delta.mjs make <old.wasm> <new.wasm> <out.kdelta>
//   node scripts/cad-delta.mjs apply <old.wasm> <patch.kdelta> <out.wasm>      (a check)
//
// Format (little-endian): "KDL1", u32 new length, then ops until the end:
//   0x01 u32 offset u32 length   copy from the old file
//   0x02 u32 length bytes...     insert these bytes
//   0x03 u32 offset u32 length bytes...  copy from the old file, adding these bytes (mod 256):
//                                mostly zeros where only an index or offset changed (bsdiff's idea)
// The patch is served Brotli-compressed, which shrinks the inserted bytes and the op stream; the
// decoder (in SolidCraft's service worker, patches/solidcraft/0003) is a dozen lines.
import { readFileSync, writeFileSync } from 'node:fs';

const BLOCK = 32; // bytes hashed to find matches
const MIN_MATCH = 48; // shorter matches cost more than inserting the bytes
const TABLE_BITS = 24;

function hashAt(buf, i) {
  // FNV-1a over BLOCK bytes (computed from scratch: matching is driven by sampled positions).
  let h = 0x811c9dc5;
  for (let k = 0; k < BLOCK; k++) h = Math.imul(h ^ buf[i + k], 16777619);
  return (h >>> (32 - TABLE_BITS)) >>> 0;
}

export function makeDelta(oldBuf, newBuf) {
  // Index the old file every STEP bytes.
  const STEP = 8;
  const table = new Int32Array(1 << TABLE_BITS).fill(-1);
  for (let i = 0; i + BLOCK <= oldBuf.length; i += STEP) table[hashAt(oldBuf, i)] = i;

  const out = [];
  let size = 0;
  const push = (b) => { out.push(b); size += b.length; };
  const header = Buffer.alloc(8);
  header.write('KDL1', 0, 'latin1');
  header.writeUInt32LE(newBuf.length, 4);
  push(header);

  let pending = 0; // start of bytes not yet emitted
  const flushInsert = (end) => {
    let at = pending;
    while (at < end) {
      const n = Math.min(end - at, 0xffffffff);
      const op = Buffer.alloc(5);
      op[0] = 2;
      op.writeUInt32LE(n, 1);
      push(op);
      push(newBuf.subarray(at, at + n));
      at += n;
    }
  };
  let lastOld = 0; // where the previous copy ended in the old file: try continuing there first
  let i = 0;
  while (i + BLOCK <= newBuf.length) {
    let cand = -1;
    // Most edits leave the following bytes in the same place relative to the last copy.
    if (lastOld + BLOCK <= oldBuf.length && newBuf.compare(oldBuf, lastOld, lastOld + BLOCK, i, i + BLOCK) === 0) cand = lastOld;
    else {
      const c = table[hashAt(newBuf, i)];
      if (c >= 0 && newBuf.compare(oldBuf, c, c + BLOCK, i, i + BLOCK) === 0) cand = c;
    }
    if (cand < 0) { i++; continue; }
    // Extend backwards into the pending bytes, then forwards.
    let s = i, o = cand;
    while (s > pending && o > 0 && newBuf[s - 1] === oldBuf[o - 1]) { s--; o--; }
    let e = i + BLOCK, oe = cand + BLOCK;
    while (e < newBuf.length && oe < oldBuf.length && newBuf[e] === oldBuf[oe]) { e++; oe++; }
    if (e - s < MIN_MATCH) { i++; continue; }
    // Keep going through small differences while bytes still mostly match (score: +1 a match,
    // -1 a difference; stop when it falls well below its best).
    let score = 0, best = 0, bestEnd = e;
    for (let k = e, ko = oe; k < newBuf.length && ko < oldBuf.length; k++, ko++) {
      score += newBuf[k] === oldBuf[ko] ? 1 : -2;
      if (score > best) { best = score; bestEnd = k + 1; }
      else if (score < best - 64) break;
    }
    flushInsert(s);
    const len = bestEnd - s;
    const fuzzy = bestEnd > e;
    const op = Buffer.alloc(9);
    op[0] = fuzzy ? 3 : 1;
    op.writeUInt32LE(o, 1);
    op.writeUInt32LE(len, 5);
    push(op);
    if (fuzzy) {
      const diff = Buffer.alloc(len);
      for (let k = 0; k < len; k++) diff[k] = (newBuf[s + k] - oldBuf[o + k]) & 255;
      push(diff);
    }
    pending = i = bestEnd;
    lastOld = o + len;
  }
  flushInsert(newBuf.length);
  return Buffer.concat(out, size);
}

export function applyDelta(oldBuf, patch) {
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  if (String.fromCharCode(patch[0], patch[1], patch[2], patch[3]) !== 'KDL1') throw new Error('not a KDL1 patch');
  const out = new Uint8Array(view.getUint32(4, true));
  let p = 8, w = 0;
  while (p < patch.length) {
    const op = patch[p];
    if (op === 1) {
      const off = view.getUint32(p + 1, true), len = view.getUint32(p + 5, true);
      out.set(oldBuf.subarray(off, off + len), w);
      w += len; p += 9;
    } else if (op === 3) {
      const off = view.getUint32(p + 1, true), len = view.getUint32(p + 5, true);
      for (let k = 0; k < len; k++) out[w + k] = (oldBuf[off + k] + patch[p + 9 + k]) & 255;
      w += len; p += 9 + len;
    } else if (op === 2) {
      const len = view.getUint32(p + 1, true);
      out.set(patch.subarray(p + 5, p + 5 + len), w);
      w += len; p += 5 + len;
    } else throw new Error(`bad op ${op} at ${p}`);
  }
  if (w !== out.length) throw new Error(`patch made ${w} bytes, expected ${out.length}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'make') {
    const t = Date.now();
    const patch = makeDelta(readFileSync(a), readFileSync(b));
    writeFileSync(c, patch);
    console.log(`${c}: ${(patch.length / 1e6).toFixed(1)} MB raw patch in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } else if (cmd === 'apply') {
    writeFileSync(c, applyDelta(readFileSync(a), readFileSync(b)));
  } else {
    console.error('usage: cad-delta.mjs make|apply ...');
    process.exit(2);
  }
}
