// Keel's default scripts: parametric generators any document can run. Each is
// {id, name, description, params: [{key, title, type, unit?, default, min?, max?, options?}], build(params) → [{command, params}]}
// and build is pure, so the same list runs in the browser (window.solidcraft.execute) or headless
// (scripts/run-script.mjs → solidcraft-cli run).
import propeller from './propeller.js';

export const SCRIPTS = [propeller];

export const byId = (id) => SCRIPTS.find((s) => s.id === id);

/** Defaults for a script's params, as a plain object. */
export const defaults = (script) => Object.fromEntries(script.params.map((p) => [p.key, p.default]));
