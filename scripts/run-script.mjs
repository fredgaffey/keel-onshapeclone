#!/usr/bin/env node
// Print a default script's command list as a solidcraft-cli script:
//   node scripts/run-script.mjs propeller blades=3 diameter=152.4 > prop.json
//   solidcraft-cli run prop.json --out prop.step --out prop.stl
import { SCRIPTS, byId } from '../public/js/scripts/index.js';

const [id, ...rest] = process.argv.slice(2);
const script = id && byId(id);
if (!script) {
  console.error(`usage: run-script.mjs <id> [key=value…]\nscripts: ${SCRIPTS.map((s) => s.id).join(', ')}`);
  if (script === undefined && id) process.exit(2);
  for (const s of SCRIPTS) {
    console.error(`\n${s.id}: ${s.description}`);
    for (const p of s.params) console.error(`  ${p.key}=${p.default}${p.unit ? ' ' + p.unit : ''}  ${p.title}${p.options ? ` (${p.options.join('|')})` : ''}`);
  }
  process.exit(id ? 2 : 1);
}
const params = {};
for (const kv of rest) {
  const i = kv.indexOf('=');
  if (i < 1) { console.error(`expected key=value, got "${kv}"`); process.exit(2); }
  const key = kv.slice(0, i);
  if (!script.params.some((p) => p.key === key)) { console.error(`${id} has no parameter "${key}"`); process.exit(2); }
  params[key] = kv.slice(i + 1);
}
process.stdout.write(JSON.stringify({ commands: script.build(params) }, null, 1) + '\n');
