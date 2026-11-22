// Build public/agents/catalog.json, the format reference agents read (describe_format,
// list_commands without a browser): SolidCraft's commands with their parameters, and example
// features as they appear in a design file, made by running real commands in a headless Keel tab.
//   npm run dev, then: node scripts/feature-catalog.mjs      (CHROME= a Chrome binary)
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.KEEL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const BLOCKED = /^(file|doc|app|plugin|script|window|help|prefs)\./;

// Each example: commands to run on an empty design, and which new features to keep as examples.
const EXAMPLES = [
  ['box', [{ command: 'solid.box', params: { length: 40, width: 30, height: 8, name: 'Base plate', body_name: 'Plate' } }]],
  ['cylinder', [{ command: 'solid.cylinder', params: { radius: 6, height: 20, name: 'Boss', body_name: 'Boss' } }]],
  ['sphere', [{ command: 'solid.sphere', params: { radius: 10, name: 'Ball', body_name: 'Ball' } }]],
  ['sketch and extrude', [
    { command: 'sketch.create', params: { plane: 'XY', name: 'Plate outline' } },
    { command: 'sketch.rectangle.center', params: { center: [0, 0], corner: [30, 20] } },
    { command: 'sketch.circle.center', params: { center: [15, 0], radius: 4 } },
    { command: 'sketch.finish' },
    { command: 'solid.extrude', params: { distance: '6 mm', name: 'Plate', body_name: 'Plate' } },
  ]],
  ['revolve', [
    { command: 'sketch.create', params: { plane: 'XZ', name: 'Knob profile' } },
    { command: 'sketch.rectangle.two_point', params: { p0: [5, 0], p1: [12, 20] } },
    { command: 'sketch.finish' },
    { command: 'solid.revolve', params: { axis: 'Z', name: 'Knob', body_name: 'Knob' } },
  ]],
  ['fillet', [
    { command: 'solid.box', params: { length: 40, width: 30, height: 10, name: 'Block', body_name: 'Block' } },
    { command: 'solid.fillet', params: { edges: [[20, 0, 10]], radius: '2 mm', name: 'Top edge round' } },
  ]],
  ['circular pattern', [
    { command: 'solid.cylinder', params: { radius: 20, height: 5, name: 'Disc', body_name: 'Disc' } },
    { command: 'solid.cylinder', params: { radius: 2, height: 5, center: [15, 0, 0], operation: 'cut', name: 'Bolt hole' } },
    { command: 'solid.pattern.circular', params: { features: ['Bolt hole'], axis: 'Z', count: 6, name: 'Bolt circle' } },
  ]],
];

const r = await (await fetch(`${BASE}/api/loose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Catalog', by: 'catalog' }) })).json();
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--enable-unsafe-webgpu'] });
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/d/${r.document.id}?host=1#key=${r.key}`);
await page.waitForSelector('.banner', { timeout: 180000 });
const out = await page.evaluate(async (examples) => {
  const sc = document.getElementById('cad').contentWindow.solidcraft;
  const commands = await sc.commands();
  const made = {};
  const errors = {};
  for (const [name, cmds] of examples) {
    await sc.request('document.import', { text: JSON.stringify({ format: 'solidcraft/57', name: 'x', units: 'mm', params: [], features: [], next_id: 1 }), name: 'x' });
    try {
      await sc.request('engine.batch', { commands: cmds, rollback: true }).then((b) => { if (b.failed) throw new Error(`${b.failed.command}: ${b.failed.error}`); });
      made[name] = JSON.parse((await sc.request('document.export')).text).features;
    } catch (e) { errors[name] = e.message; }
  }
  const format = JSON.parse((await sc.request('document.export')).text).format;
  return { commands, made, errors, format };
}, EXAMPLES);
await browser.close();

const commands = (Array.isArray(out.commands) ? out.commands : out.commands.commands || [])
  .filter((c) => !BLOCKED.test(c.id))
  .map((c) => ({ id: c.id, label: c.label, tab: c.tab, params: c.params ?? c.params_doc ?? c.doc ?? null }));
const catalog = {
  about: 'SolidCraft commands (for run_commands) and example features as stored in a design (for write_document and edit_document add). Built by scripts/feature-catalog.mjs.',
  format: out.format,
  commands,
  examples: Object.fromEntries(Object.entries(out.made).map(([k, feats]) => [k, { commands: EXAMPLES.find((e) => e[0] === k)[1], features: feats }])),
};
writeFileSync(new URL('../public/agents/catalog.json', import.meta.url), JSON.stringify(catalog, null, 1));
console.log(`${commands.length} commands, examples: ${Object.keys(out.made).join(', ')}${Object.keys(out.errors).length ? `; failed: ${JSON.stringify(out.errors)}` : ''}`);
