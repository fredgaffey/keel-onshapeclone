// Scripts panel: Keel's default parametric generators (public/js/scripts/). Pick one, fill in its
// parameters, Create: build(params) gives a SolidCraft command list, run one command at a time
// through app.execute(command, params) inside the host's engine queue (Keel's `serial`).
// Same panel pattern as flexblade.js (a shadow-DOM box, top right).
import { SCRIPTS, byId } from './scripts/index.js';

/** Run a command list through app.execute; stops at the first failure, naming the step. */
export async function runCommands(app, commands, progress = () => {}) {
  for (let i = 0; i < commands.length; i++) {
    const { command, params } = commands[i];
    progress(i, commands.length, command);
    try { await app.execute(command, params); }
    catch (e) {
      // leave no sketch half-open behind a failed step
      try { await app.execute('sketch.cancel', {}); } catch { /* none open */ }
      throw new Error(`step ${i + 1}/${commands.length} (${command}): ${e.message || e}`);
    }
  }
  return commands.length;
}

/** Options: app (window.solidcraft), frame (the SolidCraft iframe), run (the host's engine queue). Returns {toggle, el}. */
export function install(opts = {}) {
  const engine = async (fn) => {
    const run = opts.run || ((f) => f());
    const r = await run(async () => { try { return { value: await fn() }; } catch (error) { return { error }; } });
    if (!r) throw new Error('engine queue returned nothing');
    if (r.error) throw r.error;
    return r.value;
  };
  const frame = opts.frame || document.getElementById('cad');
  const appOf = () => opts.app || (frame && frame.contentWindow && frame.contentWindow.solidcraft) || window.solidcraft;

  const host = document.createElement('div');
  host.id = 'scripts-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
  <div class="p"><div class="h"><b>◆</b> Scripts <button class="x" title="close">×</button></div>
  <div class="b">
    <select class="pick">${SCRIPTS.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
    <div class="d"></div>
    <form class="f"></form>
    <div class="row"><button class="pri go">Create</button><button class="rst" type="button">Defaults</button></div>
    <div class="s"></div>
  </div></div>`;
  document.body.append(host);
  const $ = (s) => root.querySelector(s);
  const st = $('.s'), form = $('.f');
  const say = (m, err = false) => { st.textContent = m; st.className = 's' + (err ? ' err' : ''); };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    const s = byId($('.pick').value);
    $('.d').textContent = s.description;
    form.innerHTML = s.params.map((p) => {
      const id = `f-${p.key}`;
      const input = p.type === 'enum'
        ? `<select id="${id}" name="${p.key}">${p.options.map((o) => `<option${o === p.default ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input id="${id}" name="${p.key}" value="${esc(p.default)}" ${p.type === 'string' ? 'type="text"' : `type="number" step="any"${p.min != null ? ` min="${p.min}"` : ''}${p.max != null ? ` max="${p.max}"` : ''}`}>`;
      return `<label for="${id}">${esc(p.title)}${p.unit ? ` <i>${esc(p.unit)}</i>` : ''}</label>${input}`;
    }).join('');
    say('');
  }
  $('.pick').addEventListener('change', render);
  $('.rst').addEventListener('click', render);
  form.addEventListener('submit', (e) => e.preventDefault());

  $('.go').addEventListener('click', async () => {
    const s = byId($('.pick').value);
    const app = appOf();
    if (!app) return say('SolidCraft API not found (is the modeller loaded?)', true);
    let commands;
    // a fresh name tag per run: a second part in the same document gets its own sketch/body names
    try { commands = s.build(Object.fromEntries(new FormData(form)), { tag: ` ${Date.now().toString(36).slice(-4)}` }); }
    catch (e) { return say(e.message, true); }
    $('.go').disabled = true;
    const t0 = performance.now();
    try {
      const n = await engine(() => runCommands(app, commands, (i, total, c) => say(`${i + 1}/${total} ${c}…`)));
      say(`${s.name}: ${n} commands in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) { say(e.message, true); }
    finally { $('.go').disabled = false; }
  });

  render();
  const toggle = (show) => { host.style.display = (show ?? host.style.display === 'none') ? '' : 'none'; };
  $('.x').addEventListener('click', () => toggle(false));
  return { toggle, el: host };
}

const CSS = `
:host { all: initial; }
.p { position: fixed; right: 14px; top: 56px; width: 300px; max-height: calc(100vh - 80px); display: flex; flex-direction: column; z-index: 2147483000;
  font: 12px/1.4 system-ui, sans-serif; color: #d8dee6; background: #161a1f; border: 1px solid #2a313a; border-radius: 6px; box-shadow: 0 8px 28px #0007; }
.h { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-bottom: 1px solid #2a313a; font-weight: 600; }
.h b { color: #e9a23b; } .h .x { margin-left: auto; cursor: pointer; color: #8592a1; background: none; border: 0; font-size: 14px; }
.b { padding: 8px 10px; display: flex; flex-direction: column; gap: 7px; overflow: auto; }
.d { color: #8592a1; }
.f { display: grid; grid-template-columns: 1fr 92px; gap: 4px 6px; align-items: center; }
.f label { color: #aab4c0; } .f i { color: #8592a1; font-style: normal; }
input, select { width: 100%; box-sizing: border-box; background: #1c2128; color: inherit; border: 1px solid #38414c; border-radius: 4px; padding: 3px 6px; font: 11px ui-monospace, monospace; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
button { background: #1c2128; color: inherit; border: 1px solid #38414c; border-radius: 4px; padding: 4px 9px; cursor: pointer; font: inherit; }
button.pri { background: #e9a23b; border-color: #e9a23b; color: #1a1208; font-weight: 600; }
button:disabled { opacity: .5; }
.s { color: #8592a1; font: 11px ui-monospace, monospace; white-space: pre-wrap; max-height: 120px; overflow: auto; }
.s.err { color: #e5534b; }
`;
