// phase "warm": load the live site (current build) and wait until SolidCraft keeps it.
// phase "update": reload after the deploy and see how the new module arrives.
import { chromium } from '@playwright/test';
const [phase, url] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext('/private/tmp/claude-501/-Users-fred-random-stuff-onshape/44d10419-56b9-467f-b217-2e42603857de/scratchpad/update-profile', { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--enable-unsafe-webgpu'], viewport: { width: 1200, height: 800 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const seen = [];
ctx.on('response', (q) => { const u = q.url(); if (u.includes('/cad/delta/') || u.endsWith('_bg.wasm')) seen.push(q.status() + ' ' + u.split('/cad/')[1].slice(0, 50)); });
ctx.on('serviceworker', (w) => w.on('response', () => {}));
await page.goto(url, { waitUntil: 'commit' });
await page.waitForSelector('#loading', { state: 'hidden', timeout: 300000 });
const kept = async () => page.evaluate(async () => {
  const out = [];
  for (const k of await caches.keys()) if (k.startsWith('solidcraft-app /cad/ 0')) { const c = await caches.open(k); const keys = (await c.keys()).map((q) => q.url); out.push({ k, n: keys.length, complete: keys.some((u) => u.includes('complete')), wasm: (keys.find((u) => u.endsWith('_bg.wasm')) || '').split('/').pop() }); }
  return out;
});
let st;
for (let i = 0; i < 60; i++) { st = await kept(); if (st.length && st[st.length - 1].complete && (phase === 'warm' || st.length > 1 && st.every((s) => s.complete))) break; await page.waitForTimeout(5000); }
const wasm = await page.evaluate(() => [...document.getElementById('cad').contentWindow.performance.getEntriesByType('resource')].filter((e) => e.name.includes('_bg.wasm') || e.name.includes('/delta/')).map((e) => e.name.split('/cad/')[1].slice(0, 40) + ' ' + (e.transferSize / 1e6).toFixed(2) + 'MB'));
console.log(phase, JSON.stringify(st), '\n page loads:', JSON.stringify(wasm), '\n network:', JSON.stringify(seen));
await ctx.close();
