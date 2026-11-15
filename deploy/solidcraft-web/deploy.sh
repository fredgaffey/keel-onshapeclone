#!/usr/bin/env bash
# Build SolidCraft for the browser and stage it for Cloudflare.
#   ./deploy.sh            build and stage into ./public, upload to LOCAL R2 (for `wrangler dev`)
#   ./deploy.sh --remote   build and stage, then upload to your Cloudflare account and deploy
# SOLIDCRAFT_DIR overrides where the SolidCraft checkout is (default: ../../../solidcraft).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
sc=$(cd "${SOLIDCRAFT_DIR:-$here/../../../solidcraft}" && pwd)
mode=${1:---local}
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  (cd "$sc/apps/solidcraft-web" && trunk build --release --public-url ./)
fi
rm -rf "$here/public"
cp -R "$sc/dist/web" "$here/public"
rm -f "$here/public/.trunk-lock"
wasm=$(cd "$here/public" && ls *_bg.wasm)
echo "Compressing $wasm with Brotli (takes a few minutes)..."
brotli -f -q 11 -w 24 -o "$here/build-$wasm.br" "$here/public/$wasm"
printf '*_bg.wasm\n' > "$here/public/.assetsignore"

cd "$here"
wrangler r2 object put "solidcraft-web-wasm/$wasm" --file "build-$wasm.br" \
  --content-type application/wasm "$mode"
if [[ "$mode" == "--remote" ]]; then
  wrangler deploy
else
  echo "Staged locally. Run: (cd $here && wrangler dev)"
fi
