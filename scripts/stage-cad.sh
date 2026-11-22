#!/usr/bin/env bash
# Stage SolidCraft's browser build into public/cad/ and its WebAssembly into R2.
#   scripts/stage-cad.sh            upload the WebAssembly to LOCAL R2 (for `wrangler dev`)
#   scripts/stage-cad.sh --remote   upload it to your Cloudflare account's R2 bucket
# SOLIDCRAFT_DIR: the SolidCraft checkout (default ../solidcraft). BUILD=1 rebuilds it first
# (about 15 minutes), applying Keel's fixes in patches/solidcraft/; otherwise its existing
# dist/web is used.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sc=$(cd "${SOLIDCRAFT_DIR:-$root/../solidcraft}" && pwd)
mode=${1:---local}
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

if [[ "${BUILD:-}" == 1 || ! -d "$sc/dist/web" ]]; then
  # Keel's fixes to SolidCraft (patches/solidcraft/*.patch), until they're upstream: each one is
  # applied unless the checkout already has it (already applied, or fixed upstream).
  for patch in "$root"/patches/solidcraft/*.patch; do
    [[ -e "$patch" ]] || continue
    name=$(basename "$patch")
    if git -C "$sc" apply --check -R "$patch" 2>/dev/null; then
      echo "patch $name: already in the SolidCraft checkout"
    elif git -C "$sc" apply --check "$patch" 2>/dev/null; then
      git -C "$sc" apply "$patch" && echo "patch $name: applied"
    else
      echo "patch $name: doesn't apply; check whether upstream fixed it, then delete it from patches/solidcraft/" >&2
      exit 1
    fi
  done
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
