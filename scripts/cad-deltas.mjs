// Patches from recent SolidCraft builds' WebAssembly to the new one, uploaded to R2 at
// cad/delta/<old sha256>-<new sha256> (Brotli-compressed; served by the Worker at /cad/delta/).
// SolidCraft's service worker (patches/solidcraft/0003) fetches the one for the build it has.
//   node scripts/cad-deltas.mjs <new.wasm> --local|--remote
// Older builds are the Brotli copies stage-cad.sh keeps in build/ (the newest few are used).
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, brotliCompressSync, constants } from 'node:zlib';
import { basename, join } from 'node:path';
import { makeDelta } from './cad-delta.mjs';

const KEEP = Number(process.env.DELTA_FROM || 3); // how many earlier builds get a patch
const [newPath, mode = '--local'] = process.argv.slice(2);
const root = new URL('..', import.meta.url).pathname;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const next = readFileSync(newPath);
const nextSha = sha(next);
const olds = readdirSync(join(root, 'build'))
  .filter((f) => f.endsWith('_bg.wasm.br') && f !== `${basename(newPath)}.br`)
  .map((f) => ({ f, t: statSync(join(root, 'build', f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, KEEP);
mkdirSync(join(root, 'build', 'delta'), { recursive: true });
for (const { f } of olds) {
  const old = brotliDecompressSync(readFileSync(join(root, 'build', f)));
  const oldSha = sha(old);
  const key = `${oldSha}-${nextSha}`;
  const t = Date.now();
  const patch = brotliCompressSync(makeDelta(old, next), { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: next.length } });
  const file = join(root, 'build', 'delta', key);
  writeFileSync(file, patch);
  console.log(`${f.replace('_bg.wasm.br', '')} → new: ${(patch.length / 1e6).toFixed(1)} MB (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  execFileSync('wrangler', ['r2', 'object', 'put', `keel-files/cad/delta/${key}`, '--file', file, '--content-type', 'application/octet-stream', mode], { stdio: ['ignore', 'ignore', 'inherit'] });
}
if (!olds.length) console.log('No earlier builds in build/: no patches (the next build will have one from this).');
