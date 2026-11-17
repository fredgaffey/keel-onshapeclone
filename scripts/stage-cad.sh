#!/usr/bin/env bash
# Stage SolidCraft's browser build into public/cad/ and its WebAssembly into R2.
#   scripts/stage-cad.sh            upload the WebAssembly to LOCAL R2 (for `wrangler dev`)
#   scripts/stage-cad.sh --remote   upload it to your Cloudflare account's R2 bucket
# SOLIDCRAFT_DIR: the SolidCraft checkout (default ../solidcraft). BUILD=1 rebuilds it first
# (about 15 minutes); otherwise its existing dist/web is used.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sc=$(cd "${SOLIDCRAFT_DIR:-$root/../solidcraft}" && pwd)
mode=${1:---local}
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

if [[ "${BUILD:-}" == 1 || ! -d "$sc/dist/web" ]]; then
  (cd "$sc/apps/solidcraft-web" && trunk build --release --public-url ./)
fi
rm -rf "$root/public/cad"
cp -R "$sc/dist/web" "$root/public/cad"
rm -f "$root/public/cad/.trunk-lock"
wasm=$(cd "$root/public/cad" && ls *_bg.wasm)
mkdir -p "$root/build"
if [[ ! -f "$root/build/$wasm.br" ]]; then
  echo "Compressing $wasm with Brotli (a few minutes)..."
  brotli -f -q 11 -w 24 -o "$root/build/$wasm.br" "$root/public/cad/$wasm"
fi
# Static assets are capped at 25 MiB a file: the WebAssembly is served from R2 by the Worker.
# (public/.assetsignore keeps it out of the static assets.)

cd "$root"
wrangler r2 object put "keel-files/cad/$wasm" --file "build/$wasm.br" --content-type application/wasm "$mode"
