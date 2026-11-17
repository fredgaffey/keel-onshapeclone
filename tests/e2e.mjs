// End-to-end test of Keel against a running server (`npm run dev`, default http://127.0.0.1:8787):
// accounts, documents, sharing, versions, and live editing between two browsers, including a
// simultaneous edit, an offline edit, and a view-only collaborator.
//   KEEL_URL=http://127.0.0.1:8787 CHROME=/path/to/chrome node tests/e2e.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const BASE = process.env.KEEL_URL || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--use-angle=metal', '--enable-unsafe-webgpu'] });
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    console.log(results.at(-1));
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    console.log(results.at(-1));
    throw e;
  }
};

async function person(name) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 820 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  const call = async (path, method = 'GET', body) => {
    const res = await context.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: body ? { 'content-type': 'application/json' } : {} });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  };
  return { name, context, page, call, email: `${name.toLowerCase()}-${run}@example.com` };
}

const cad = (page, fn, arg) => page.frameLocator('#cad').locator('body').evaluate(fn, arg);
const features = (page) => cad(page, async () => JSON.parse((await window.solidcraft.request('document.export')).text).features.map((f) => f.name));
const statusText = (page) => page.locator('#status-text').textContent();
async function until(what, fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const alice = await person('Alice');
const bob = await person('Bob');
const carol = await person('Carol');
let docId;

try {
  await step('sign-up, sign-in and wrong password', async () => {
    for (const p of [alice, bob, carol]) {
      const r = await p.call('/signup', 'POST', { name: p.name, email: p.email, password: 'correct horse battery' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    assert.equal((await alice.call('/signup', 'POST', { name: 'x', email: alice.email, password: 'whatever123' })).status, 409);
    assert.equal((await bob.call('/login', 'POST', { email: bob.email, password: 'nope nope nope' })).status, 401);
    assert.equal((await bob.call('/login', 'POST', { email: bob.email, password: 'correct horse battery' })).status, 200);
    assert.equal((await alice.call('/me')).body.user.email, alice.email);
  });

  await step('documents: create, list, rename, cross-site refusal', async () => {
    const r = await alice.call('/docs', 'POST', { name: 'Bracket' });
    assert.equal(r.status, 201);
    docId = r.body.document.id;
    assert.ok((await alice.call('/docs')).body.documents.some((d) => d.id === docId));
    assert.equal((await bob.call(`/docs/${docId}`)).status, 404, 'not shared yet');
    assert.equal((await alice.call(`/docs/${docId}`, 'PATCH', { name: 'Bracket v1' })).status, 200);
    const res = await alice.context.request.fetch(`${BASE}/api/docs`, { method: 'POST', data: { name: 'x' }, headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    assert.equal(res.status(), 403);
  });

  await step('sharing: edit for Bob, view for Carol', async () => {
    assert.equal((await alice.call(`/docs/${docId}/shares`, 'POST', { email: bob.email, role: 'edit' })).status, 200);
    assert.equal((await alice.call(`/docs/${docId}/shares`, 'POST', { email: carol.email, role: 'view' })).status, 200);
    assert.equal((await bob.call(`/docs/${docId}/shares`, 'POST', { email: carol.email, role: 'edit' })).status, 403, 'only the owner shares');
    assert.equal((await carol.call(`/docs/${docId}/content`, 'PUT', { text: '{}' })).status, 403);
    const listed = (await bob.call('/docs')).body.documents.find((d) => d.id === docId);
    assert.equal(listed.role, 'edit');
  });

  await step('the home page lists the document', async () => {
    await alice.page.goto(BASE);
    await alice.page.getByText('Bracket v1').waitFor();
    await alice.page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/home.png` : '/dev/null' });
  });

  await step('both open the editor', async () => {
    // One after the other: on `wrangler dev`, two 32 MB downloads at once from local R2 sometimes
    // cut one off (on Cloudflare each browser downloads from its own edge).
    await bob.page.goto(`${BASE}/d/${docId}`);
    await until('Bob connected', async () => (await statusText(bob.page)) === 'All changes saved', 180_000);
    await alice.page.goto(`${BASE}/d/${docId}`);
    for (const p of [alice, bob]) await until(`${p.name} connected`, async () => (await statusText(p.page)) === 'All changes saved', 180_000);
    await until('two people shown', async () => (await alice.page.locator('#peers .avatar').count()) === 2);
    // (For the offline steps.) SolidCraft finishes keeping its own files for offline use in the background after it starts.
    await until('SolidCraft kept for offline use', () => bob.page.frameLocator('#cad').locator('body').evaluate(async () => {
      for (const k of await caches.keys()) if ((await (await caches.open(k)).keys()).some((r) => r.url.endsWith('build-complete'))) return true;
      return false;
    }), 120_000);
  });

  await step('Alice adds a box; Bob sees it live', async () => {
    await cad(alice.page, () => window.solidcraft.execute('solid.box', { length: 30, width: 20, height: 10, body_name: 'Base' }));
    await until('Bob has Box1', async () => (await features(bob.page)).includes('Box1'), 20_000);
    await until('Alice saved', async () => (await statusText(alice.page)) === 'All changes saved');
  });

  await step('simultaneous edits merge', async () => {
    await Promise.all([
      cad(alice.page, () => window.solidcraft.execute('solid.box', { length: 5, width: 5, height: 40, body_name: 'Post' })),
      cad(bob.page, () => window.solidcraft.execute('solid.box', { length: 60, width: 4, height: 4, body_name: 'Rail' })),
    ]);
    const want = (list) => list.length === 3;
    await until('both have three features', async () => want(await features(alice.page)) && want(await features(bob.page)), 30_000);
    await until('both saved', async () => (await statusText(alice.page)) === 'All changes saved' && (await statusText(bob.page)) === 'All changes saved');
    const a = await cad(alice.page, () => window.solidcraft.request('document.export'));
    const b = await cad(bob.page, () => window.solidcraft.request('document.export'));
    assert.deepEqual(JSON.parse(a.text).features, JSON.parse(b.text).features, 'the two designs agree');
    const bodies = await cad(bob.page, async () => (await window.solidcraft.inspect()).bodies?.map((x) => x.name) ?? null);
    if (bodies) for (const n of ['Base', 'Post', 'Rail']) assert.ok(bodies.includes(n), `body ${n} in ${bodies}`);
    const server = (await alice.call(`/docs/${docId}/content`)).body;
    assert.equal(JSON.parse(server.text).features.length, 3);
  });

  await step('an edit made offline arrives when Bob reconnects', async () => {
    await bob.context.setOffline(true);
    await until('Bob shows offline', async () => (await statusText(bob.page)).startsWith('Offline'));
    await cad(bob.page, () => window.solidcraft.execute('solid.box', { length: 8, width: 8, height: 8, body_name: 'Offline' }));
    await until('Bob keeps it on the device', async () => bob.page.evaluate(async (id) => {
      const d = await new Promise((res) => { const r = indexedDB.open('keel'); r.onsuccess = () => { const g = r.result.transaction('docs').objectStore('docs').get(id); g.onsuccess = () => res(g.result); }; });
      return d && d.local && d.local.includes('"Offline"');
    }, docId));
    await bob.context.setOffline(false);
    await until('Alice gets the offline box', async () => (await features(alice.page)).length === 4, 60_000);
  });

  await step('Bob reloads with no network, edits, and it syncs later', async () => {
    await bob.context.setOffline(true);
    await bob.page.reload();
    await until('Bob\'s editor opened offline', async () => (await features(bob.page)).length === 4, 120_000);
    await cad(bob.page, () => window.solidcraft.execute('solid.box', { length: 3, width: 3, height: 3, body_name: 'Plane' }));
    await until('Bob shows unsent changes', async () => (await statusText(bob.page)).includes('kept on this device'));
    await bob.context.setOffline(false);
    await until('Alice gets the box made offline', async () => (await features(alice.page)).length === 5, 60_000);
  });

  await step('Carol can view but not save', async () => {
    await carol.page.goto(`${BASE}/d/${docId}`);
    await until('Carol loaded', async () => (await statusText(carol.page)) === 'View only', 180_000);
    assert.equal((await features(carol.page)).length, 5);
    await cad(carol.page, () => window.solidcraft.execute('solid.box', { length: 1, width: 1, height: 1, body_name: 'Nope' }));
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(JSON.parse((await alice.call(`/docs/${docId}/content`)).body.text).features.length, 5);
  });

  await step('versions: save, change, restore', async () => {
    const v = await alice.call(`/docs/${docId}/versions`, 'POST', { name: 'Five boxes' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    await cad(alice.page, () => window.solidcraft.execute('solid.box', { length: 2, width: 2, height: 2, body_name: 'Fifth' }));
    await until('Bob has six', async () => (await features(bob.page)).length === 6);
    assert.equal((await alice.call(`/docs/${docId}/versions/${v.body.id}/restore`, 'POST', {})).status, 200);
    await until('both back to five', async () => (await features(alice.page)).length === 5 && (await features(bob.page)).length === 5);
    if (process.env.SHOTS) await bob.page.screenshot({ path: `${process.env.SHOTS}/editor.png` });
  });

  await step('removing Bob\'s access disconnects him', async () => {
    assert.equal((await alice.call(`/docs/${docId}/shares/${(await bob.call('/me')).body.user.id}`, 'DELETE')).status, 200);
    assert.equal((await bob.call(`/docs/${docId}/content`)).status, 404);
  });
} finally {
  console.log(`\n${results.filter((r) => r.startsWith('ok')).length}/${results.length} steps passed`);
  await browser.close();
}
