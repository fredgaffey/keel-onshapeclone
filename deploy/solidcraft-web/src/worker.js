// Every request is a static asset, except the WebAssembly binary. That file
// is excluded from assets by .assetsignore, so requests for it reach this
// Worker, which serves the Brotli-compressed copy from R2.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("_bg.wasm")) {
      const obj = await env.WASM.get(url.pathname.slice(1));
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "application/wasm",
          "content-encoding": "br",
          // The file name contains a content hash, so it can be cached forever.
          "cache-control": "public, max-age=31536000, immutable",
          etag: obj.httpEtag,
        },
        encodeBody: "manual", // already compressed; send the bytes as they are
      });
    }
    return env.ASSETS.fetch(request);
  },
};
