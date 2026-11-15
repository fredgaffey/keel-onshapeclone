# SolidCraft on Cloudflare

Hosts a browser build of [SolidCraft](https://github.com/tangency-labs/solidcraft) on Cloudflare Workers.

- Small files (HTML, JS, fonts, icons) are **Workers static assets**.
- The WebAssembly binary is 166 MB (32 MB with Brotli), over the 25 MiB static-asset limit. It lives in **R2**, compressed, and `src/worker.js` serves it with `Content-Encoding: br`.
- SolidCraft's own service worker caches the app after the first load, so it then works offline.

## Use

Requires a SolidCraft checkout at `../../../solidcraft` (or set `SOLIDCRAFT_DIR`), plus `rustup`, `trunk`, `brotli` and `wrangler`.

```sh
./deploy.sh              # build, stage into ./public, upload the wasm to LOCAL R2
wrangler dev             # test at http://localhost:8787
./deploy.sh --remote     # upload to your Cloudflare account and deploy
```

One-time setup for `--remote`: `wrangler login`, enable R2 on the account, then run `wrangler r2 bucket create solidcraft-web-wasm`.

## Licence note

SolidCraft's code is MIT/Apache-2.0, but its name, look, icons and UI kit fall under `LICENSE-BRAND`. Hosting your own build for development, testing or learning is fine. A public deployment of a modified build needs the maintainers' written permission, or a rebrand. Keep personal deployments private, for example with Cloudflare Access.
