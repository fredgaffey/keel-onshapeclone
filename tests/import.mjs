// Importing files, end to end against a running server with SolidCraft staged (npm run dev):
// STEP and STL through the home page, a Fusion 360 file getting the export advice, and an agent
// importing through MCP into a host tab.   node tests/import.mjs   (CHROME= a Chrome binary)
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.KEEL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STEP = new URL('../examples/propeller/prop-5x4.3-2blade.step', import.meta.url).pathname;
const STL = new URL('../examples/propeller/prop-5x4.3-2blade.stl', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'keel-import-'));
let passed = 0;
async function step(name, fn) { const t = Date.now(); await fn(); passed++; console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }

const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
// A signed-in user (dev mode makes anyone without a session "Dev"; elsewhere sign up).
const run = Date.now().toString(36);
const signup = await ctx.request.post(`${BASE}/api/signup`, { data: { email: `import-${run}@example.com`, name: 'Imp', password: 'correct horse' }, headers: { origin: BASE } });
assert.ok(signup.ok(), await signup.text());

const inspect = (page) => page.evaluate(() => document.getElementById('cad').contentWindow.solidcraft.request('document.inspect', { timeline: 'summary', bodies: true, measure: true }));
async function importThrough(page, file, units) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#import');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await chooser).setFiles(file);
  if (units) {
    await page.waitForSelector('dialog select');
    await page.selectOption('dialog select', units);
    await page.click('dialog button[value=ok]');
  }
  await page.waitForURL(/\/d\//, { timeout: 15_000 });
  await page.waitForSelector('#loading', { state: 'hidden', timeout: 240_000 });
  // Converted, saved, and the banner gone.
  await page.waitForFunction(() => window.keelSync && window.keelSync.known && window.keelSync.known === window.keelSync.base && JSON.parse(window.keelSync.known).features.length > 0, null, { timeout: 180_000, polling: 500 });
  return inspect(page);
}

try {
  await step('STEP through the home page: exact solids, saved to the server', async () => {
    const page = await ctx.newPage();
    const d = await importThrough(page, STEP);
    assert.ok(d.bodies.length >= 1, JSON.stringify(d).slice(0, 300));
    const vol = d.bodies.reduce((s, b) => s + (b.volume_mm3 || 0), 0);
    assert.ok(vol > 2500 && vol < 3500, `propeller volume ${vol} (about 3028 mm³)`);
    const id = new URL(page.url()).pathname.split('/')[2];
    const saved = await (await ctx.request.get(`${BASE}/api/docs/${id}/content`)).json();
    assert.ok(JSON.parse(saved.text).features.length > 0, 'on the server');
    const name = await (await ctx.request.get(`${BASE}/api/docs/${id}`)).json();
    assert.equal(name.document.name, 'prop-5x4.3-2blade');
    await page.screenshot({ path: join(dir, 'step.png') });
    await page.close();
  });

  await step('STL with its units chosen up front: no prompt in the modeller', async () => {
    const page = await ctx.newPage();
    const d = await importThrough(page, STL, 'mm');
    assert.ok(d.bodies.length >= 1);
    const ui = await page.evaluate(() => document.getElementById('cad').contentWindow.solidcraft.request('ui.inspect'));
    assert.ok(!ui.dialog, 'no units dialog left open');
    await page.close();
  });

  await step('a Fusion 360 file: told how to export it, nothing created', async () => {
    const f3d = join(dir, 'Bracket v3.f3d');
    writeFileSync(f3d, 'PK fake fusion archive');
    const before = (await (await ctx.request.get(`${BASE}/api/docs`)).json()).documents.length;
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    const chooser = page.waitForEvent('filechooser');
    await page.click('#import');
    await (await chooser).setFiles(f3d);
    await page.waitForSelector('dialog .head');
    assert.match(await page.textContent('dialog'), /Fusion 360[\s\S]*File → Export[\s\S]*STEP/);
    const after = (await (await ctx.request.get(`${BASE}/api/docs`)).json()).documents.length;
    assert.equal(after, before);
    await page.close();
  });

  await step('an agent imports a STEP file through MCP into a host tab', async () => {
    const made = await (await fetch(`${BASE}/api/loose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Agent import"}' })).json();
    const host = await ctx.newPage();
    await host.goto(`${BASE}/d/${made.document.id}?host=1#key=${made.key}`);
    await host.waitForSelector('.banner', { timeout: 240_000 });
    const tool = async (name, args) => (await (await fetch(`${BASE}/mcp/loose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
    const r = await tool('import_file', { id: made.key, name: 'propeller.step', data: readFileSync(STEP).toString('base64') });
    assert.ok(!r.isError, r.content[0].text);
    assert.ok(JSON.parse(r.content[0].text).parts >= 1);
    let ins;
    for (let i = 0; i < 60; i++) { await new Promise((ok) => setTimeout(ok, 1000)); ins = await tool('inspect_model', { id: made.key, measure: true }); if (!ins.isError && JSON.parse(ins.content[0].text).bodies?.length) break; }
    const parsed = JSON.parse(ins.content[0].text);
    assert.ok(parsed.bodies.length >= 1, ins.content[0].text.slice(0, 300));
    const closed = await tool('import_file', { id: made.key, name: 'x.f3d', data: 'AAAA' });
    assert.ok(closed.isError && /export STEP/.test(closed.content[0].text));
    await host.close();
  });
} finally {
  await browser.close();
}
console.log(`\n${passed} steps passed (screenshots in ${dir})`);
