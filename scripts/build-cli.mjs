// Build public/keel.mjs: cli/keel.mjs with the modules it imports from public/js inlined, so the
// site can serve it as one file (curl -O https://<site>/keel.mjs && node keel.mjs help).
// Each module goes in its own function scope, so their private names can't collide.
//   node scripts/build-cli.mjs            (KEEL_SITE=https://... sets the default site)
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const root = new URL('..', import.meta.url);
let src = readFileSync(new URL('cli/keel.mjs', root), 'utf8');
const re = /^import \{([^}]+)\} from '\.\.\/public\/js\/([\w-]+\.js)';$/gm;
src = src.replace(re, (_, names, file) => {
  let mod = readFileSync(new URL(`public/js/${file}`, root), 'utf8');
  if (/^import /m.test(mod)) throw new Error(`${file} imports other modules; inline those too`);
  const exported = [...mod.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
  mod = mod.replace(/^export (?=(async )?(function|const|let|class) )/gm, '');
  return `// ---- inlined from public/js/${file}\nconst {${names}} = (() => {\n${mod}\nreturn { ${exported.join(', ')} };\n})();`;
});
if (process.env.KEEL_SITE) src = src.replace(/const DEFAULT_SITE = '[^']*';/, `const DEFAULT_SITE = '${process.env.KEEL_SITE.replace(/\/+$/, '')}';`);
src = src.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n// Built from cli/keel.mjs by scripts/build-cli.mjs. Edit that, not this.\n');
const out = new URL('public/keel.mjs', root);
writeFileSync(out, src);
chmodSync(out, 0o755);
console.log(`wrote public/keel.mjs (${(src.length / 1024).toFixed(0)} KB)`);
